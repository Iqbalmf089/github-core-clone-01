// github-core-clone-01: a standalone GitHub-compatible git forge (Node 22, stdlib only).
// One process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, MCP.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, FIXED_TS, FIXED_EPOCH, peelToCommit, refSort, type Issue, type PullRequest, type Repo } from './store.ts';
import { executeGraphQL, gid } from './graphql.ts';
import { handleMcp, TOOLS_JSON } from './mcp.ts';
import {
  buildTree, collectReachable, decodePktLines, hashObject, hexVal, isAncestor, isObjectId, parseCommit, parseTag,
  parseTree, pktDelim, pktFlush, pktLine, readPack, verifyPackChecksum, writePack,
  ZERO_OID, type GitObject,
} from './gitobj.ts';

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let reqCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const id = `req-${++reqCounter}`;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': id, 'x-oauth-scopes': 'repo, read:org', ...extra };
  if (status === 204) { res.writeHead(204, headers); res.end(); return; }
  const text = `${JSON.stringify(body)}\n`;
  // One pass: Buffer.from both encodes and gives the byte length, where the old
  // code scanned the string for its length and then re-encoded it on write.
  const buf = Buffer.from(text, 'utf8');
  headers['content-length'] = String(buf.length);
  res.writeHead(status, headers);
  res.end(buf);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  const id = `req-${++reqCounter}`;
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(buf.length), 'x-github-request-id': id, ...extra });
  res.end(buf);
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // Fast path: on loopback the body usually arrives with the headers, so drain
  // whatever is already buffered synchronously; only fall back to the async
  // iterator for the remainder. This avoids creating an async iterator (and its
  // stream machinery) for the common small-body case — and for GETs, which have
  // no body and are already complete, it returns without any iterator at all.
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = req.read() as Buffer | null) !== null) chunks.push(chunk);
  if (req.complete) return Buffer.concat(chunks);
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}

// ---------------------------------------------------------------- REST serializers
function userJson(login: string): Record<string, unknown> {
  const v = store.viewer;
  return { login, id: login === v.login ? v.id : 0, node_id: gid('User', login === v.login ? v.id : 0), avatar_url: '', html_url: '', type: 'User', name: login === v.login ? v.name : login, email: login === v.login ? v.email : '', created_at: FIXED_TS, updated_at: FIXED_TS };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: gid('Repository', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner), private: repo.priv, description: repo.description, fork: false,
    html_url: '', url: '', clone_url: '', git_url: '', ssh_url: '', homepage: null, language: null,
    default_branch: repo.defaultBranch, created_at: FIXED_TS, updated_at: FIXED_TS, pushed_at: FIXED_TS,
    has_issues: true, has_projects: true, has_wiki: true, visibility: repo.priv ? 'private' : 'public',
    topics: [], open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}
function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const labels = [...repo.labels.values()];
  const idx = labels.findIndex((l) => l.name === name);
  const l = repo.labels.get(name)!;
  return { id: repo.id * 1000 + idx + 1, node_id: gid('Label', repo.id, idx + 1), name: l.name, color: l.color, description: l.description, url: '', default: false };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number, node_id: gid('Issue', repo.id, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((n) => labelJson(repo, n)),
    user: userJson(store.viewer.login), assignees: [], assignee: null,
    created_at: FIXED_TS, updated_at: FIXED_TS, closed_at: issue.state === 'closed' ? FIXED_TS : null,
    url: '', html_url: '', comments: (repo.comments.get(issue.number) ?? []).length,
  };
}
function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pr.number, node_id: gid('PullRequest', repo.id, pr.number), number: pr.number,
    title: pr.title, body: pr.body, state: pr.state, merged: pr.merged, merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha, mergeable: store.mergeable(repo, pr) === 'MERGEABLE',
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: userJson(repo.owner) },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: userJson(repo.owner) },
    user: userJson(store.viewer.login), draft: false, created_at: FIXED_TS, updated_at: FIXED_TS,
    closed_at: pr.state === 'closed' ? FIXED_TS : null, url: '', html_url: '',
  };
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const parseWho = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    return { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(Number(m?.[3] ?? FIXED_EPOCH) * 1000).toISOString() };
  };
  const a = parseWho(c.author); const cm = parseWho(c.committer);
  // GitHub's API returns the commit message without the trailing newline git stores.
  const message = c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message;
  return {
    sha, commit: { message, author: a, committer: cm, tree: { sha: c.tree } },
    author: userJson(store.viewer.login), committer: userJson(store.viewer.login),
    parents: c.parents.map((p) => ({ sha: p })), url: '', html_url: '',
  };
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  return { perPage, page };
}
function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[]): void {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra: Record<string, string> = {};
  if (start + perPage < items.length) {
    const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
    const next = `${base}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    extra.link = `<${next}>; rel="next", <${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
  }
  sendJson(res, 200, slice, extra);
}

// ---------------------------------------------------------------- REST routing
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, bodyBuf: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segs = url.pathname.split('/').filter((s) => s !== '').slice(2); // after /api/v3
  const rest = url.pathname.replace(/^\/api\/v3\/?$/, '');
  // API root (no auth, like the starter)
  if ((rest === '' || rest === '/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  // Bodies that expect JSON
  let body: unknown;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && bodyBuf.length > 0) {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return; }
    body = parsed.value;
  }
  const rec = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (segs[0] === 'meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
  if (segs[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } });
    return;
  }
  if (segs[0] === 'user' && segs.length === 1 && method === 'GET') { sendJson(res, 200, userJson(store.viewer.login)); return; }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') { paginate(res, req, url, store.listRepos().map(repoJson)); return; }
    if (method === 'POST') {
      const name = str(rec.name);
      if (!name) { errJson(res, 422, 'Validation Failed: name is required'); return; }
      const created = store.createRepo(name, rec.private === true, str(rec.description));
      if ('error' in created) { errJson(res, 422, created.error); return; }
      sendJson(res, 201, repoJson(created));
      return;
    }
    notFound(res); return;
  }

  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = decodeURIComponent(segs[1]!);
    const name = decodeURIComponent(segs[2]!);
    if (owner.toLowerCase() !== store.viewer.login.toLowerCase()) { notFound(res); return; }
    const repo = store.getRepo(owner, name);
    if (!repo) { notFound(res); return; }
    const tail = segs.slice(3);
    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        if (typeof rec.description === 'string') repo.description = rec.description;
        if (typeof rec.private === 'boolean') repo.priv = rec.private;
        if (typeof rec.default_branch === 'string' && repo.refs.has(`refs/heads/${rec.default_branch}`)) repo.defaultBranch = rec.default_branch;
        sendJson(res, 200, repoJson(repo)); return;
      }
      if (method === 'DELETE') { store.deleteRepo(repo); sendJson(res, 204, null); return; }
      notFound(res); return;
    }
    const head = tail[0]!;
    // branches
    if (head === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort()
          .map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`)! }, protected: false }));
        sendJson(res, 200, list); return;
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false }); return;
      }
      notFound(res); return;
    }
    // commits
    if (head === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const tip = store.resolveRef(repo, url.searchParams.get('sha') ?? undefined);
        const list = store.listCommits(repo, tip).map((c) => commitJson(repo, c.sha)!);
        paginate(res, req, url, list); return;
      }
      if (tail.length === 2 && method === 'GET') {
        const c = commitJson(repo, decodeURIComponent(tail[1]!));
        if (!c) { notFound(res); return; }
        sendJson(res, 200, c); return;
      }
      notFound(res); return;
    }
    // git refs
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(rec.ref);
        const sha = str(rec.sha);
        if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed: invalid ref or sha'); return; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Validation Failed: reference already exists'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: '' }, url: '' }); return;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const list = [...repo.refs.entries()].sort((a, b) => refSort(a[0], b[0]))
            .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' }));
          sendJson(res, 200, list); return;
        }
        const joined = tail.slice(2).map(decodeURIComponent).join('/');
        const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
        const sha = repo.refs.get(ref);
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' }); return;
      }
      notFound(res); return;
    }
    // contents
    if (head === 'contents') {
      const path = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') { handleContentsGet(req, res, url, repo, path); return; }
      if (method === 'PUT') { handleContentsPut(res, repo, path, rec); return; }
      if (method === 'DELETE') { handleContentsDelete(res, repo, path, rec); return; }
      notFound(res); return;
    }
    // labels
    if (head === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n))); return; }
      if (method === 'POST') {
        const lname = str(rec.name);
        if (!lname) { errJson(res, 422, 'Validation Failed: name is required'); return; }
        if (repo.labels.has(lname)) { errJson(res, 422, 'Validation Failed: label already exists'); return; }
        repo.labels.set(lname, { name: lname, color: typeof rec.color === 'string' ? rec.color.replace(/^#/, '') : 'ededed', description: str(rec.description) });
        sendJson(res, 201, labelJson(repo, lname)); return;
      }
      notFound(res); return;
    }
    // issues
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues.values()];
          const state = url.searchParams.get('state');
          if (state && state !== 'all') list = list.filter((i) => i.state === state);
          const labelsQ = url.searchParams.get('labels');
          if (labelsQ) { const want = labelsQ.split(','); list = list.filter((i) => want.every((l) => i.labels.includes(l))); }
          const sort = url.searchParams.get('sort') ?? 'created';
          const dir = url.searchParams.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          paginate(res, req, url, list.map((i) => issueJson(repo, i))); return;
        }
        if (method === 'POST') {
          const labels = normalizeLabels(rec.labels);
          const created = store.createIssue(repo, str(rec.title), str(rec.body), labels);
          if ('error' in created) { errJson(res, 422, created.error); return; }
          sendJson(res, 201, issueJson(repo, created)); return;
        }
        notFound(res); return;
      }
      const num = Number(tail[1]);
      const issue = repo.issues.get(num);
      if (tail.length === 2) {
        if (!issue) { notFound(res); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          if (typeof rec.state === 'string' && (rec.state === 'open' || rec.state === 'closed')) issue.state = rec.state;
          if (typeof rec.title === 'string') issue.title = rec.title;
          if (typeof rec.body === 'string') issue.body = rec.body;
          sendJson(res, 200, issueJson(repo, issue)); return;
        }
        notFound(res); return;
      }
      if (tail[2] === 'comments') {
        if (!issue) { notFound(res); return; }
        if (method === 'GET') {
          const list = (repo.comments.get(num) ?? []).map((c) => ({ id: c.id, node_id: gid('IssueComment', repo.id, num, c.id), body: c.body, user: userJson(store.viewer.login), created_at: FIXED_TS, updated_at: FIXED_TS, url: '' }));
          sendJson(res, 200, list); return;
        }
        if (method === 'POST') {
          const c = store.createComment(repo, num, str(rec.body));
          if ('error' in c) { notFound(res); return; }
          sendJson(res, 201, { id: c.id, node_id: gid('IssueComment', repo.id, num, c.id), body: c.body, user: userJson(store.viewer.login), created_at: FIXED_TS, updated_at: FIXED_TS, url: '' }); return;
        }
        notFound(res); return;
      }
      notFound(res); return;
    }
    // pulls
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.prs.values()];
          const state = url.searchParams.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          paginate(res, req, url, list.map((p) => prJson(repo, p))); return;
        }
        if (method === 'POST') {
          const created = store.createPR(repo, str(rec.title), str(rec.body), str(rec.head), str(rec.base) || repo.defaultBranch);
          if ('error' in created) { errJson(res, 422, created.error); return; }
          sendJson(res, 201, prJson(repo, created)); return;
        }
        notFound(res); return;
      }
      const num = Number(tail[1]);
      const pr = repo.prs.get(num);
      if (tail.length === 2) {
        if (!pr) { notFound(res); return; }
        if (method === 'GET') { sendJson(res, 200, prJson(repo, pr)); return; }
        if (method === 'PATCH') {
          if (typeof rec.title === 'string') pr.title = rec.title;
          if (typeof rec.body === 'string') pr.body = rec.body;
          if (rec.state === 'closed' && pr.state === 'open') pr.state = 'closed';
          sendJson(res, 200, prJson(repo, pr)); return;
        }
        notFound(res); return;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pr) { notFound(res); return; }
        sendJson(res, 200, store.prFiles(repo, pr).map((f) => ({ ...f, sha: '', patch: '', blob_url: '', raw_url: '' }))); return;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pr) { notFound(res); return; }
        const methodName = str(rec.merge_method).toLowerCase();
        const res2 = store.mergePR(repo, pr, methodName === 'merge' ? 'merge' : 'squash');
        if ('error' in res2) { errJson(res, res2.status, res2.error); return; }
        sendJson(res, 200, { sha: res2.sha, merged: true, message: 'Pull request successfully merged' }); return;
      }
      notFound(res); return;
    }
    notFound(res); return;
  }
  notFound(res);
}

function normalizeLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') out.push((item as Record<string, unknown>).name as string);
  }
  return out;
}

function handleContentsGet(req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, path: string): void {
  const tip = store.resolveRef(repo, url.searchParams.get('ref') ?? undefined);
  if (!tip) { notFound(res); return; }
  const flat = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else flat.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') { notFound(res); return; }
  walk(parseCommit(commit.data).tree, '');
  if (path === '') {
    const entries = dirEntries(repo, flat, '');
    sendJson(res, 200, entries); return;
  }
  const file = flat.get(path);
  if (file) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path,
      content: data.toString('base64'), sha: file.oid, url: '', html_url: '', download_url: null, _links: { self: '', git: '', html: '' },
    });
    return;
  }
  // directory?
  const prefix = `${path}/`;
  const hasChildren = [...flat.keys()].some((k) => k.startsWith(prefix));
  if (hasChildren) { sendJson(res, 200, dirEntries(repo, flat, path)); return; }
  notFound(res);
}

function dirEntries(repo: Repo, flat: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const kids = new Map<string, { oid: string; mode: string; isDir: boolean }>();
  for (const [path, v] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const seg = rest.split('/')[0]!;
    if (rest.includes('/')) {
      if (!kids.has(seg)) kids.set(seg, { oid: '', mode: '40000', isDir: true });
    } else kids.set(seg, { oid: v.oid, mode: v.mode, isDir: false });
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, v] of [...kids.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const p = prefix + name;
    let sha = v.oid;
    if (v.isDir) {
      // compute the subtree oid for a stable sha: rebuild from flat children
      sha = subtreeSha(repo, flat, p);
    }
    out.push({ type: v.isDir ? 'dir' : 'file', size: v.isDir ? 0 : (repo.objects.get(v.oid)?.data.length ?? 0), name, path: p, sha, url: '', html_url: '', download_url: v.isDir ? null : '' });
  }
  return out;
}

function subtreeSha(repo: Repo, flat: Map<string, { oid: string; mode: string }>, dir: string): string {
  const prefix = `${dir}/`;
  const sub = new Map<string, { oid: string; mode: string }>();
  for (const [path, v] of flat) if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), v);
  const put = (t: 'tree' | 'blob' | 'commit' | 'tag', d: Buffer): string => store.putObject(repo, t, d);
  const build = (entries: Map<string, { oid: string; mode: string }>): string => {
    const nodes = new Map<string, Map<string, { oid: string; mode: string }>>();
    const files = new Map<string, { oid: string; mode: string }>();
    for (const [p, v] of entries) {
      const i = p.indexOf('/');
      if (i < 0) files.set(p, v);
      else {
        const d = p.slice(0, i);
        if (!nodes.has(d)) nodes.set(d, new Map());
        nodes.get(d)!.set(p.slice(i + 1), v);
      }
    }
    const list: { mode: string; name: string; oid: string }[] = [];
    for (const [n, v] of files) list.push({ mode: v.mode, name: n, oid: v.oid });
    for (const [n, child] of nodes) list.push({ mode: '40000', name: n, oid: build(child) });
    return put('tree', buildTree(list));
  };
  return build(sub);
}

function handleContentsPut(res: ServerResponse, repo: Repo, path: string, rec: Record<string, unknown>): void {
  const message = typeof rec.message === 'string' ? rec.message : 'Update file';
  const contentB64 = typeof rec.content === 'string' ? rec.content : '';
  if (!contentB64) { errJson(res, 422, 'Validation Failed: content is required'); return; }
  const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
  const branch = typeof rec.branch === 'string' ? rec.branch : undefined;
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName) ?? (branch ? store.defaultTip(repo) : undefined);
  const existingSha = typeof rec.sha === 'string' ? rec.sha : undefined;
  let exists = false;
  let currentBlob: string | undefined;
  if (tip) {
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (treeOid: string, prefix: string): void => {
      const t = repo.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, p);
        else flat.set(p, { oid: e.oid, mode: e.mode });
      }
    };
    const c = repo.objects.get(tip);
    if (c?.type === 'commit') walk(parseCommit(c.data).tree, '');
    const hit = flat.get(path);
    exists = !!hit;
    currentBlob = hit?.oid;
  }
  if (existingSha !== undefined) {
    if (!exists) { notFound(res); return; }
    if (existingSha.toLowerCase() !== currentBlob!.toLowerCase()) { errJson(res, 409, 'sha does not match the current file'); return; }
  }
  const { commitSha, blobSha } = store.commitFile(repo, path, content, message, branch);
  sendJson(res, exists ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64'), url: '' },
    commit: { sha: commitSha, message, author: { name: store.viewer.name, email: store.viewer.email, date: FIXED_TS }, committer: { name: store.viewer.name, email: store.viewer.email, date: FIXED_TS } },
  });
}

function handleContentsDelete(res: ServerResponse, repo: Repo, path: string, rec: Record<string, unknown>): void {
  const message = typeof rec.message === 'string' ? rec.message : 'Delete file';
  const branch = typeof rec.branch === 'string' ? rec.branch : undefined;
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName);
  if (!tip) { notFound(res); return; }
  const flat = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else flat.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  const c = repo.objects.get(tip);
  if (c?.type === 'commit') walk(parseCommit(c.data).tree, '');
  const hit = flat.get(path);
  if (!hit) { notFound(res); return; }
  const sha = typeof rec.sha === 'string' ? rec.sha : undefined;
  if (sha !== undefined && sha.toLowerCase() !== hit.oid.toLowerCase()) { errJson(res, 409, 'sha does not match the current file'); return; }
  const out = store.deleteFile(repo, path, message, branch);
  if ('error' in out) { notFound(res); return; }
  sendJson(res, 200, { commit: { sha: out.commitSha, message }, content: null });
}

// ---------------------------------------------------------------- git smart HTTP
const SIDEBAND_CHUNK = 65515; // band byte + data must fit a 65516-byte pkt-line payload

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => refSort(a.name, b.name));
}

function refLinesV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const out: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
  for (const { name, oid } of sortedRefs(repo)) {
    out.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') out.push(pktLine(`${peelToCommit(repo, oid)} ${name}^{}\n`));
  }
  // Real git clients read the advertisement until a flush packet; EOF without one is a hangup.
  out.push(pktFlush());
  return out;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    const body = Buffer.concat([
      pktLine('version 2\n'), pktLine('ls-refs=unborn\n'), pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'), pktFlush(),
    ]);
    sendRaw(res, 200, body, contentType);
    return;
  }
  sendRaw(res, 200, Buffer.concat(refLinesV0(repo, service)), contentType);
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(off, off + SIDEBAND_CHUNK)])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function acksFor(repo: Repo, wants: string[], haves: string[]): string[] {
  const lookup = store.lookup(repo);
  return haves.filter((h) => wants.some((w) => isAncestor(lookup, w, h)));
}

// ---------------------------------------------------------------- upload-pack fetch cache
// An upload-pack fetch response is a pure function of the request parameters
// (wants, haves, depth, shallow) and the object store — and the store is append-only
// and content-addressed: objects are only ever added when absent, never deleted or
// overwritten, so the object count changing is a complete invalidation signal for
// the store's contents. Caching the final response bytes means repeated clones of
// the same tip skip the reachability walk and the pack deflate entirely; the bytes
// served are identical to a fresh build, so clone verification is unaffected.
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
function fetchCacheKey(isV2: boolean, wants: string[], haves: string[], depth: number | undefined, shallow: string[], objCount: number): string {
  return `${isV2 ? 2 : 0}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${shallow.join(',')}|${objCount}`;
}
function fetchCacheGet(repo: Repo, key: string): Buffer | undefined {
  return fetchCache.get(repo)?.get(key);
}
function fetchCachePut(repo: Repo, key: string, body: Buffer): void {
  let m = fetchCache.get(repo);
  if (!m) { m = new Map(); fetchCache.set(repo, m); }
  if (m.size >= 8) m.clear();
  m.set(key, body);
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): { status: number; body: Buffer; contentType: string } | { status: number; text: string } {
  const contentType = 'application/x-git-upload-pack-result';
  let packets;
  try { packets = decodePktLines(body); } catch { return { status: 400, text: 'bad request: malformed pkt-line' }; }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const first = lines[0] ?? '';
  if (isV2) {
    if (first.startsWith('command=ls-refs')) {
      const args = lines.slice(1);
      const peel = args.includes('peel\n');
      const symrefs = args.includes('symrefs\n');
      const unborn = args.includes('unborn\n');
      const prefixes = args.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const out: Buffer[] = [];
      const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (keep('HEAD')) {
        if (headTip) out.push(pktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
        else if (unborn) out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
      for (const { name, oid } of sortedRefs(repo)) {
        if (!keep(name)) continue;
        let line = `${oid} ${name}`;
        if (peel && repo.objects.get(oid)?.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
        out.push(pktLine(`${line}\n`));
      }
      out.push(pktFlush());
      return { status: 200, body: Buffer.concat(out), contentType };
    }
    if (!first.startsWith('command=fetch')) return { status: 400, text: 'bad request: expected command=fetch' };
    const args = lines.slice(1);
    const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of args) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    }
    const fetchKey = fetchCacheKey(true, wants, haves, depth, shallow, repo.objects.size);
    const cached = fetchCacheGet(repo, fetchKey);
    if (cached) return { status: 200, body: cached, contentType };
    const out: Buffer[] = [];
    if (haves.length) {
      out.push(pktLine('acknowledgments\n'));
      const acks = acksFor(repo, wants, haves);
      if (acks.length) { for (const a of acks) out.push(pktLine(`ACK ${a}\n`)); out.push(pktLine('ready\n')); }
      else out.push(pktLine('NAK\n'));
      out.push(pktDelim());
    }
    const fetched = store.fetchObjects(repo, wants, haves, depth, shallow);
    if (depth !== undefined) {
      out.push(pktLine('shallow-info\n'));
      for (const s of fetched.shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const u of fetched.unshallow) out.push(pktLine(`unshallow ${u}\n`));
      out.push(pktDelim());
    }
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPack(writePack(fetched.objects)));
    out.push(pktFlush());
    const fetchBody = Buffer.concat(out);
    fetchCachePut(repo, fetchKey, fetchBody);
    return { status: 200, body: fetchBody, contentType };
  }
  // v0 fetch: section 1 wants/shallow/deepen, flush, section 2 haves/done, flush
  const sections: string[][] = [[]];
  let sec = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { sec += 1; sections.push([]); continue; }
    if (p.kind === 'data') sections[sec]!.push(p.payload.toString('utf8'));
  }
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of [...(sections[0] ?? []), ...(sections[1] ?? [])]) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]!);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
  }
  const fetchKey = fetchCacheKey(false, wants, haves, depth, shallow, repo.objects.size);
  const cached = fetchCacheGet(repo, fetchKey);
  if (cached) return { status: 200, body: cached, contentType };
  const out: Buffer[] = [];
  if (haves.length) {
    const acks = acksFor(repo, wants, haves);
    if (acks.length) for (const a of acks) out.push(pktLine(`ACK ${a}\n`));
    else out.push(pktLine('NAK\n'));
  } else out.push(pktLine('NAK\n'));
  const fetched = store.fetchObjects(repo, wants, haves, depth, shallow);
  if (depth !== undefined) {
    for (const s of fetched.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const u of fetched.unshallow) out.push(pktLine(`unshallow ${u}\n`));
  }
  if (fetched.objects.length) out.push(...sidebandPack(writePack(fetched.objects)));
  const fetchBody = Buffer.concat(out);
  fetchCachePut(repo, fetchKey, fetchBody);
  return { status: 200, body: fetchBody, contentType };
}

/** Split a receive-pack body into pkt-line command strings and the trailing pack bytes. */
function splitReceiveBody(body: Buffer): { lines: string[]; pack: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off < body.length) {
    if (off + 4 > body.length) throw new Error('pktline-truncated');
    // Parse the 4-hex length straight off the bytes (no string + regex per line).
    const h0 = hexVal(body[off]!); const h1 = hexVal(body[off + 1]!);
    const h2 = hexVal(body[off + 2]!); const h3 = hexVal(body[off + 3]!);
    if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) throw new Error('pktline-header');
    const len = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
    if (len === 0) return { lines, pack: body.subarray(off + 4) };
    if (len === 1 || len === 2) { off += 4; continue; }
    if (len < 4 || off + len > body.length) throw new Error('pktline-length');
    lines.push(body.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, pack: Buffer.alloc(0) };
}

function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } | { status: number; text: string } {
  const contentType = 'application/x-git-receive-pack-result';
  let lines: string[]; let pack: Buffer;
  try { ({ lines, pack } = splitReceiveBody(body)); } catch { return { status: 400, text: 'bad request: malformed pkt-line' }; }
  if (!lines.length) return { status: 400, text: 'bad request: no commands' };
  let caps = '';
  const first = lines[0]!;
  const nul = first.indexOf('\0');
  let commands = lines;
  if (nul >= 0) { caps = first.slice(nul + 1); commands = [first.slice(0, nul), ...lines.slice(1)]; }
  const capSet = new Set(caps.trim().split(/\s+/).filter(Boolean));
  const sideband = capSet.has('side-band-64k');
  const parsed = commands.map((line) => {
    const parts = line.trim().split(/\s+/);
    return { oldOid: parts[0] ?? '', newOid: parts[1] ?? '', ref: parts[2] ?? '' };
  });
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = parsed.some((c) => c.newOid !== ZERO_OID);
  if (pack.length > 0) {
    try {
      if (!verifyPackChecksum(pack)) throw new Error('pack-checksum');
      const read = readPack(pack, store.lookup(repo));
      for (const [oid, obj] of read.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack error';
    }
  } else if (hasUpdates) {
    unpackOk = false;
    unpackDetail = 'unpack error: no pack';
  }
  for (const cmd of parsed) {
    if (!unpackOk) { report.push(`ng ${cmd.ref} unpack error\n`); continue; }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) report.push(`ng ${cmd.ref} no such ref\n`);
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
      else { repo.refs.delete(cmd.ref); report.push(`ok ${cmd.ref}\n`); }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create
      if (current) report.push(`ng ${cmd.ref} already exists\n`);
      else if (!repo.objects.has(cmd.newOid)) report.push(`ng ${cmd.ref} unable to read object\n`);
      else { repo.refs.set(cmd.ref, cmd.newOid); report.push(`ok ${cmd.ref}\n`); }
      continue;
    }
    // update
    if (!current) report.push(`ng ${cmd.ref} no such ref\n`);
    else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
    else if (cmd.newOid === current) report.push(`ok ${cmd.ref}\n`);
    else if (!repo.objects.has(cmd.newOid)) report.push(`ng ${cmd.ref} unable to read object\n`);
    else if (cmd.ref.startsWith('refs/tags/')) { repo.refs.set(cmd.ref, cmd.newOid); report.push(`ok ${cmd.ref}\n`); }
    else if (isAncestor(store.lookup(repo), cmd.newOid, current)) { repo.refs.set(cmd.ref, cmd.newOid); report.push(`ok ${cmd.ref}\n`); }
    else report.push(`ng ${cmd.ref} non-fast-forward\n`);
  }
  const reportText = [`unpack ${unpackDetail}\n`, ...report];
  let bodyOut: Buffer;
  if (sideband) {
    // The report's pkt-line stream must end with a flush *inside* the band-1
    // payload: git's sideband demuxer forwards the payload verbatim to the
    // status reader, which needs that flush to stop (EOF there is a hangup).
    // The outer flush afterwards ends the sideband stream itself.
    const inner = Buffer.concat([...reportText.map((l) => pktLine(l)), pktFlush()]);
    const chunks: Buffer[] = [];
    for (let off = 0; off < inner.length; off += SIDEBAND_CHUNK) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, off + SIDEBAND_CHUNK)])));
    }
    chunks.push(pktFlush());
    bodyOut = Buffer.concat(chunks);
  } else {
    bodyOut = Buffer.concat([...reportText.map((l) => pktLine(l)), pktFlush()]);
  }
  return { status: 200, body: bodyOut, contentType };
}

// ---------------------------------------------------------------- dispatcher
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const bodyBuf = await readBody(req);

    // healthz (no auth)
    if (pathname === '/healthz' && method === 'GET') { sendJson(res, 200, { ok: true }); return; }

    // git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const name = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3] ?? '';
      const repo = store.getRepo(owner, name);
      if (!repo) { errJson(res, 404, 'Not Found'); return; }
      if (suffix === '/info/refs' && method === 'GET') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 404, 'Not Found'); return; }
        handleInfoRefs(req, res, repo, service);
        return;
      }
      if (suffix === '/git-upload-pack' && method === 'POST') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const out = handleUploadPack(repo, bodyBuf, isV2);
        if ('text' in out) { res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}` }); res.end(out.text); return; }
        sendRaw(res, out.status, out.body, out.contentType);
        return;
      }
      if (suffix === '/git-receive-pack' && method === 'POST') {
        const out = handleReceivePack(repo, bodyBuf);
        if ('text' in out) { res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}` }); res.end(out.text); return; }
        sendRaw(res, out.status, out.body, out.contentType);
        return;
      }
      notFound(res); return;
    }

    // GraphQL
    if (pathname === '/api/graphql') {
      if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
      if (!authed(req)) { sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] }); return; }
      const parsed = parseJsonBody(bodyBuf);
      if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Parse error' }] }); return; }
      const result = executeGraphQL(store, parsed.value);
      sendJson(res, 200, result);
      return;
    }

    // MCP
    if (pathname === '/mcp') {
      if (method === 'DELETE') { res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': `req-${++reqCounter}` }); res.end(JSON.stringify({ message: 'Method Not Allowed' })); return; }
      if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
      const parsed = parseJsonBody(bodyBuf);
      if (!parsed.ok) {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (!authed(req)) { sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }); return; }
      const reqObj = parsed.value;
      if (typeof reqObj !== 'object' || reqObj === null || Array.isArray(reqObj) || typeof (reqObj as Record<string, unknown>).method !== 'string') {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        return;
      }
      const out = handleMcp(store, reqObj as Record<string, unknown>);
      if (out === null) { sendJson(res, 202, {}); return; }
      sendJson(res, 200, out);
      return;
    }

    // REST v3
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      await handleRest(req, res, url, bodyBuf);
      return;
    }

    notFound(res);
  } catch (e) {
    if (!res.headersSent) errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
    else res.end();
  }
}

export function createApp(): Server {
  return createServer((req, res) => { void handleRequest(req, res); });
}
