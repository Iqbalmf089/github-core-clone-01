// MCP over streamable HTTP (JSON-RPC 2.0, plain JSON answers).
// Modern era: server/discover (2026-07-28) + legacy initialize handshake both supported.
import { FIXED_TS, type Repo, type Store } from './store.ts';
import { gid } from './graphql.ts';

export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; }

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: gid('Repository', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' }, private: repo.priv, description: repo.description,
    default_branch: repo.defaultBranch, html_url: '', url: '', created_at: FIXED_TS, updated_at: FIXED_TS,
    has_issues: true, fork: false,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];
export const TOOLS_JSON = JSON.stringify(TOOLS);

function textResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: typeof obj === 'object' && obj !== null ? obj : undefined, isError };
}
function errResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if ((!owner || !repo) && full.includes('/')) { const [o, r] = full.split('/'); if (!owner) owner = o ?? ''; if (!repo) repo = r ?? ''; }
  return { owner, repo };
}

function missingArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const n of names) if (args[n] === undefined || args[n] === null || args[n] === '') return n;
  return null;
}

/** Execute a tools/call. Returns {result} or {rpcError:{code,message}}. */
export function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const viewer = store.viewer.login;
  if (name === 'create_repo') {
    const miss = missingArg(args, ['name']);
    if (miss) return { result: errResult(`Missing required argument: ${miss}`) };
    const created = store.createRepo(String(args.name), args.private === true, String(args.description ?? ''));
    if ('error' in created) return { result: errResult(created.error) };
    return { result: textResult(repoJson(created)) };
  }
  const { owner, repo } = splitFullName(args);
  if (name === 'get_repo') {
    const miss = !owner || !repo ? 'owner/repo' : null;
    if (miss) return { result: errResult(`Missing required argument: ${miss}`) };
    const r = store.getRepo(owner, repo);
    if (!r || r.owner.toLowerCase() !== viewer.toLowerCase() && owner.toLowerCase() !== r.owner.toLowerCase()) return { result: errResult('Repository not found') };
    if (!r) return { result: errResult('Repository not found') };
    return { result: textResult(repoJson(r)) };
  }
  if (name === 'create_issue') {
    const miss = missingArg({ ...args, owner, repo }, ['owner', 'repo', 'title']);
    if (miss) return { result: errResult(`Missing required argument: ${miss}`) };
    const r = store.getRepo(owner, repo);
    if (!r) return { result: errResult('Repository not found') };
    const issue = store.createIssue(r, String(args.title), String(args.body ?? ''), []);
    if ('error' in issue) return { result: errResult(issue.error) };
    return { result: textResult({ id: gid('Issue', r.id, issue.number), number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels, url: '', created_at: FIXED_TS, updated_at: FIXED_TS }) };
  }
  if (name === 'list_issues') {
    if (!owner || !repo) return { result: errResult('Missing required argument: owner/repo') };
    const r = store.getRepo(owner, repo);
    if (!r) return { result: errResult('Repository not found') };
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = [...r.issues.values()]
      .filter((i) => state === 'all' ? true : i.state === state)
      .sort((a, b) => b.seq - a.seq)
      .map((i) => ({ id: gid('Issue', r.id, i.number), number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => ({ name: l })), created_at: FIXED_TS, updated_at: FIXED_TS }));
    return { result: textResult({ issues: list }) };
  }
  if (name === 'create_pull_request') {
    const miss = missingArg({ ...args, owner, repo }, ['owner', 'repo', 'title', 'head', 'base']);
    if (miss) return { result: errResult(`Missing required argument: ${miss}`) };
    const r = store.getRepo(owner, repo);
    if (!r) return { result: errResult('Repository not found') };
    const pr = store.createPR(r, String(args.title), String(args.body ?? ''), String(args.head), String(args.base));
    if ('error' in pr) return { result: errResult(pr.error) };
    return { result: textResult({ id: gid('PullRequest', r.id, pr.number), number: pr.number, title: pr.title, body: pr.body, state: pr.state, head: { ref: pr.headRef, sha: pr.headSha }, base: { ref: pr.baseRef, sha: pr.baseSha }, merged: false, created_at: FIXED_TS }) };
  }
  if (name === 'merge_pull_request') {
    const miss = missingArg({ ...args, owner, repo }, ['owner', 'repo', 'pull_number']);
    if (miss) return { result: errResult(`Missing required argument: ${miss}`) };
    const r = store.getRepo(owner, repo);
    if (!r) return { result: errResult('Repository not found') };
    const num = Number(args.pull_number);
    const pr = r.prs.get(num);
    if (!pr) return { result: errResult('Pull request not found') };
    const res = store.mergePR(r, pr, 'squash');
    if ('error' in res) return { result: errResult(res.error) };
    return { result: textResult({ number: pr.number, merged: true, sha: res.sha, message: 'Pull request successfully merged', state: 'closed' }) };
  }
  return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

/** Handle one decoded JSON-RPC request object. Returns the response object (or null for notifications). */
export function handleMcp(store: Store, req: Record<string, unknown>): Record<string, unknown> | null {
  const id = (req.id as string | number | null) ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params as Record<string, unknown>) ?? {};
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method.startsWith('notifications/')) return null;
  if (method === 'server/discover') {
    return ok({
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: JSON.parse(TOOLS_JSON) as unknown });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown>) ?? {};
    if (typeof params.arguments !== 'undefined' && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) {
      return err(-32602, 'Invalid params: arguments must be an object');
    }
    const out = callTool(store, toolName, args);
    if (out.rpcError) return err(out.rpcError.code, out.rpcError.message);
    return ok(out.result);
  }
  return err(-32601, `Method not found: ${method}`);
}
