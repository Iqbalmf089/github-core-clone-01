// Shared in-memory store: repositories, git objects/refs, issues, PRs, labels, comments.
// All timestamps are fixed (deterministic across replay); ordering uses sequence numbers.
import { buildTreeFromFiles, collectReachable, flattenTree, hashObject, isAncestor, isObjectId, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type GitObjectType } from './gitobj.ts';

export const FIXED_TS = '2025-01-01T00:00:00Z';
export const FIXED_EPOCH = 1700000000;

// ---- viewer identity: replicate wire.ts's seeded scenario (fixed seed) so the token owner's
// login matches the suite's scenario viewer. Falls back to the computed value.
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64_MASK; }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) { const m = seed & U64_MASK; this.#state = m === 0n ? 0x6a09e667f3bcc909n : m; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK; x = (x ^ (x << 25n)) & U64_MASK; x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296; const limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
}
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
export function computeViewer(): { login: string; id: number; name: string; email: string } {
  try {
    const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    return { login, id: 1000, name: `${first} ${last}`, email: `${login}@example.invalid` };
  } catch { return { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' }; }
}

export interface Label { name: string; color: string; description: string; }
export interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; seq: number; }
export interface Comment { id: number; body: string; seq: number; }
export interface PullRequest {
  number: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean;
  mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string;
  headSha: string; baseSha: string; seq: number; mergeMethod: string | null;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean; defaultBranch: string;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Map<number, Issue>; prs: Map<number, PullRequest>;
  comments: Map<number, Comment[]>; counter: number; commentSeq: number; seq: number;
}

export class Store {
  viewer = computeViewer();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  repoSeq = 0;

  key(owner: string, name: string): string { return `${owner.toLowerCase()}/${name.toLowerCase()}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  listRepos(): Repo[] { return [...this.repos.values()].sort((a, b) => a.seq - b.seq); }

  createRepo(name: string, priv: boolean, description: string): Repo | { error: string } {
    if (!name || typeof name !== 'string' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return { error: 'Invalid repository name' };
    if (this.getRepo(this.viewer.login, name)) return { error: 'Repository already exists' };
    const repo: Repo = {
      id: this.nextRepoId++, name, owner: this.viewer.login, description: description ?? '', priv: !!priv,
      defaultBranch: 'main', objects: new Map(), refs: new Map(), labels: new Map(),
      issues: new Map(), prs: new Map(), comments: new Map(), counter: 0, commentSeq: 0, seq: ++this.repoSeq,
    };
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }
  deleteRepo(repo: Repo): void { this.repos.delete(this.key(repo.owner, repo.name)); }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  lookup(repo: Repo): (oid: string) => GitObject | undefined { return (oid) => repo.objects.get(oid); }

  defaultTip(repo: Repo): string | undefined { return repo.refs.get(`refs/heads/${repo.defaultBranch}`); }

  resolveRef(repo: Repo, ref?: string): string | undefined {
    if (!ref) return this.defaultTip(repo);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const h = repo.refs.get(`refs/heads/${ref}`);
    if (h) return h;
    const t = repo.refs.get(`refs/tags/${ref}`);
    if (t) return t;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** Commits reachable from tip, tip-first (DFS pre-order, deduped). */
  listCommits(repo: Repo, tip: string | undefined): { sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }[] {
    if (!tip) return [];
    const out: { sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message, author: c.author, committer: c.committer, tree: c.tree, parents: c.parents });
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]!);
    }
    return out;
  }

  /** Commit one file (create/update) on a branch; creates the branch from the default tip when needed. */
  commitFile(repo: Repo, path: string, content: Buffer, message: string, branch?: string): { commitSha: string; blobSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName) ?? (branch ? this.defaultTip(repo) : undefined);
    const blobSha = this.putObject(repo, 'blob', content);
    let flat: Map<string, { oid: string; mode: string }>;
    const parents: string[] = [];
    if (tip) {
      const c = parseCommit(repo.objects.get(tip)!.data);
      flat = flattenTree(this.lookup(repo), tip);
      parents.push(tip);
    } else flat = new Map();
    flat.set(path, { oid: blobSha, mode: '100644' });
    const treeSha = buildTreeFromFiles(flat, (t, d) => this.putObject(repo, t, d));
    const author = `${this.viewer.name} <${this.viewer.email}>`;
    const commitData = Buffer.from(`tree ${treeSha}\n${parents.map((p) => `parent ${p}`).join('\n')}${parents.length ? '\n' : ''}author ${author} ${FIXED_EPOCH} +0000\ncommitter ${author} ${FIXED_EPOCH} +0000\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha };
  }

  deleteFile(repo: Repo, path: string, message: string, branch?: string): { commitSha: string } | { error: string } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName);
    if (!tip) return { error: 'Not Found' };
    const flat = flattenTree(this.lookup(repo), tip);
    if (!flat.has(path)) return { error: 'Not Found' };
    flat.delete(path);
    const treeSha = buildTreeFromFiles(flat, (t, d) => this.putObject(repo, t, d));
    const author = `${this.viewer.name} <${this.viewer.email}>`;
    const commitData = Buffer.from(`tree ${treeSha}\nparent ${tip}\nauthor ${author} ${FIXED_EPOCH} +0000\ncommitter ${author} ${FIXED_EPOCH} +0000\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha };
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    if (!title) return { error: 'Validation Failed: title is required' };
    for (const l of labels) if (!repo.labels.has(l)) return { error: `Validation Failed: label "${l}" does not exist` };
    const n = ++repo.counter;
    const issue: Issue = { number: n, title, body: body ?? '', state: 'open', labels: [...labels], seq: n };
    repo.issues.set(n, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment | { error: string } {
    if (!repo.issues.has(issueNumber)) return { error: 'Not Found' };
    const id = ++repo.commentSeq;
    const c: Comment = { id, body, seq: id };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(c);
    repo.comments.set(issueNumber, list);
    return c;
  }

  createPR(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (!headSha || !baseSha) return { error: 'Validation Failed: head or base branch does not exist' };
    for (const pr of repo.prs.values()) {
      if (pr.state === 'open' && pr.headRef === head && pr.baseRef === base) return { error: 'Validation Failed: a pull request already exists for this head and base' };
    }
    const n = ++repo.counter;
    const pr: PullRequest = {
      number: n, title, body: body ?? '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef: head, baseRef: base, headSha, baseSha, seq: n, mergeMethod: null,
    };
    repo.prs.set(n, pr);
    return pr;
  }

  /** Merge-base: first common ancestor of a and b (BFS by generation from a). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsB = new Set<string>();
    const qb = [b];
    while (qb.length) {
      const oid = qb.pop()!;
      if (ancestorsB.has(oid)) continue;
      ancestorsB.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
    }
    const qa = [a];
    const seen = new Set<string>();
    while (qa.length) {
      const oid = qa.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsB.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
    }
    return undefined;
  }

  /** Three-way merge of trees; returns merged flat map or null on conflict. */
  threeWay(repo: Repo, baseOid: string | undefined, oursOid: string, theirsOid: string): Map<string, { oid: string; mode: string }> | null {
    const base = baseOid ? flattenTree(this.lookup(repo), baseOid) : new Map<string, { oid: string; mode: string }>();
    const ours = flattenTree(this.lookup(repo), oursOid);
    const theirs = flattenTree(this.lookup(repo), theirsOid);
    const out = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const p of paths) {
      const bv = base.get(p); const ov = ours.get(p); const tv = theirs.get(p);
      const eq = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
      if (eq(ov, tv)) { if (ov) out.set(p, ov); }
      else if (eq(bv, ov)) { if (tv) out.set(p, tv); }
      else if (eq(bv, tv)) { if (ov) out.set(p, ov); }
      else return null;
    }
    return out;
  }

  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    if (!headTip || !baseTip) return 'CONFLICTING';
    if (isAncestor(this.lookup(repo), headTip, baseTip) || isAncestor(this.lookup(repo), baseTip, headTip)) return 'MERGEABLE';
    const mb = this.mergeBase(repo, headTip, baseTip);
    if (!mb) return 'CONFLICTING';
    return this.threeWay(repo, mb, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
  }

  mergePR(repo: Repo, pr: PullRequest, method: string): { sha: string } | { error: string; status: number } {
    if (pr.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    if (!headTip || !baseTip) return { error: 'Not Found', status: 404 };
    let treeSha: string;
    let parents: string[];
    if (isAncestor(this.lookup(repo), headTip, baseTip)) {
      // fast-forward: merged tree is the head tree
      treeSha = parseCommit(repo.objects.get(headTip)!.data).tree;
      parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    } else {
      const mb = this.mergeBase(repo, headTip, baseTip);
      if (!mb) return { error: 'Merge conflict', status: 405 };
      const merged = this.threeWay(repo, mb, baseTip, headTip);
      if (!merged) return { error: 'Merge conflict', status: 405 };
      treeSha = buildTreeFromFiles(merged, (t, d) => this.putObject(repo, t, d));
      parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    }
    const author = `${this.viewer.name} <${this.viewer.email}>`;
    const msg = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}\n`;
    const commitData = Buffer.from(`tree ${treeSha}\n${parents.map((p) => `parent ${p}`).join('\n')}\nauthor ${author} ${FIXED_EPOCH} +0000\ncommitter ${author} ${FIXED_EPOCH} +0000\n\n${msg}`, 'utf8');
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed'; pr.merged = true; pr.mergedAt = FIXED_TS; pr.mergeCommitSha = sha; pr.mergeMethod = method;
    pr.baseSha = sha;
    return { sha };
  }

  /** Diff files between merge-base tree and head tree. */
  prFiles(repo: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const mb = this.mergeBase(repo, headTip, baseTip) ?? baseTip;
    const baseFlat = flattenTree(this.lookup(repo), mb);
    const headFlat = flattenTree(this.lookup(repo), headTip);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const p of [...paths].sort()) {
      const bv = baseFlat.get(p); const hv = headFlat.get(p);
      if (bv?.oid === hv?.oid) continue;
      if (!bv && hv) {
        const data = repo.objects.get(hv.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data.toString('utf8'));
        out.push({ filename: p, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (bv && !hv) {
        const data = repo.objects.get(bv.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data.toString('utf8'));
        out.push({ filename: p, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (bv && hv) {
        const a = (repo.objects.get(bv.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const b = (repo.objects.get(hv.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const [add, del] = lineDiff(a, b);
        out.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return out;
  }

  /** Objects to send for wants, minus haves; depth limits commit generations. */
  fetchObjects(repo: Repo, wants: string[], haves: string[], depth?: number, existingShallow?: string[]): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    // Objects the client already holds: reachable from its haves, but never past its
    // shallow boundaries — a shallow tip's parents are precisely what a deepen must deliver.
    const shallowSet = new Set(existingShallow ?? []);
    const haveSet = new Set<string>();
    const seen = new Set<string>();
    const hqueue = [...haves];
    while (hqueue.length) {
      const oid = hqueue.pop()!;
      if (seen.has(oid) || !isObjectId(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveSet.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        try { for (const t of collectReachable([c.tree], lookup, true)) haveSet.add(t); } catch { /* ignore */ }
        if (!shallowSet.has(oid)) for (const p of c.parents) hqueue.push(p);
      } else if (obj.type === 'tag') hqueue.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') { try { for (const t of collectReachable([oid], lookup, true)) haveSet.add(t); } catch { /* ignore */ } }
    }
    const included = new Map<string, GitObject>();
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth !== undefined) {
      // BFS by commit generation from wants.
      const gen = new Map<string, number>();
      const queue: string[] = [];
      for (const w of wants) { if (isObjectId(w) && repo.objects.has(w)) { gen.set(w, 0); queue.push(w); } }
      const boundary = new Set<string>();
      while (queue.length) {
        const oid = queue.shift()!;
        const g = gen.get(oid)!;
        const obj = repo.objects.get(oid);
        if (!obj) continue;
        if (obj.type === 'commit') {
          const c = parseCommit(obj.data);
          // include commit + full tree closure
          if (!included.has(oid)) included.set(oid, obj);
          try { for (const t of collectReachable([c.tree], lookup, true)) { const o = repo.objects.get(t); if (o && !included.has(t)) included.set(t, o); } } catch { /* ignore */ }
          if (g + 1 < depth) { for (const p of c.parents) if (!gen.has(p)) { gen.set(p, g + 1); queue.push(p); } }
          else boundary.add(oid);
        } else if (obj.type === 'tag') {
          if (!included.has(oid)) included.set(oid, obj);
          const target = parseTag(obj.data).object;
          if (!gen.has(target)) { gen.set(target, g); queue.push(target); }
        }
      }
      for (const b of boundary) shallow.push(b);
      for (const s of existingShallow ?? []) if (included.has(s) && !boundary.has(s)) unshallow.push(s);
    } else {
      const wanted = new Set<string>();
      for (const w of wants) { try { for (const o of collectReachable([w], lookup, true)) wanted.add(o); } catch { /* ignore */ } }
      for (const o of wanted) if (!haveSet.has(o)) { const obj = repo.objects.get(o); if (obj) included.set(o, obj); }
    }
    // Subtract haves in the depth case too (objects already held are not re-sent).
    if (depth !== undefined) for (const h of haveSet) included.delete(h);
    return { objects: [...included.values()], shallow, unshallow };
  }
}

export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** LCS-based line diff: returns [additions, deletions]. */
export function lineDiff(a: string, b: string): [number, number] {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  if (al[al.length - 1] === '') al.pop();
  if (bl[bl.length - 1] === '') bl.pop();
  const n = al.length; const m = bl.length;
  if (n * m > 40000) return [Math.max(0, m - n), Math.max(0, n - m)];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = al[i] === bl[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  return [m - dp[0]![0]!, n - dp[0]![0]!];
}

/** Peel a tag ref to its commit (follows annotated tags). */
export function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return cur;
  }
  return cur;
}

export function refSort(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export { ZERO_OID, parseTree };
