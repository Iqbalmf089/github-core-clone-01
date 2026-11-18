// GraphQL v4: a small parser + executor for the documents gh and github-mcp-server send.
// Supports queries/mutations, aliases, variables, inline args (enums, lists, input objects),
// inline fragments, __type introspection, and batched operation arrays.
import { FIXED_TS, peelToCommit, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- global ids (opaque, stable)
export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}
export function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}

// ---------------------------------------------------------------- tokenizer / parser
type Tok = { kind: 'name' | 'string' | 'int' | 'punct' | 'var'; value: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]!; out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; j += 2; }
        else { out += src[j]; j++; }
      }
      toks.push({ kind: 'string', value: out }); i = j + 1; continue;
    }
    if (c === '$') { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++; toks.push({ kind: 'var', value: src.slice(i + 1, j) }); i = j; continue; }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ kind: 'int', value: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++; toks.push({ kind: 'name', value: src.slice(i, j) }); i = j; continue; }
    if ('{}()[]:!...'.includes(c)) {
      if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      toks.push({ kind: 'punct', value: c }); i++; continue;
    }
    i++;
  }
  return toks;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Selection {
  alias?: string; name: string; args: Record<string, Value>; selections: Selection[];
  fragment?: boolean; typeCondition?: string;
}
interface Operation { kind: 'query' | 'mutation'; name?: string; selections: Selection[]; }

class Parser {
  toks: Tok[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { const t = this.toks[this.pos]; if (!t) throw new Error('unexpected end of document'); this.pos++; return t; }
  expectPunct(v: string): void { const t = this.next(); if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`); }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') { ops.push({ kind: 'query', selections: this.parseSelections() }); continue; }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        let name: string | undefined;
        const n = this.peek();
        if (n?.kind === 'name') { name = this.next().value; }
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
          // variable definitions: skip balanced parens
          let depth = 0;
          while (this.pos < this.toks.length) { const tok = this.next(); if (tok.value === '(') depth++; else if (tok.value === ')') { depth--; if (depth === 0) break; } }
        }
        ops.push({ kind: t.value as 'query' | 'mutation', name, selections: this.parseSelections() });
        continue;
      }
      throw new Error(`unexpected token ${t.value}`);
    }
    return ops;
  }
  parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') { this.next(); break; }
      out.push(this.parseSelection());
    }
    return out;
  }
  parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let typeCondition: string | undefined;
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') { this.next(); typeCondition = this.next().value; }
      return { name: '', args: {}, selections: this.parseSelections(), fragment: true, typeCondition };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected field name, got ${first.value}`);
    let alias: string | undefined; let name = first.value;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') { this.next(); alias = name; name = this.next().value; }
    const args: Record<string, Value> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (true) {
        const nt = this.peek()!;
        if (nt.kind === 'punct' && nt.value === ')') { this.next(); break; }
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selections = this.parseSelections();
    return { alias, name, args, selections };
  }
  parseValue(): Value {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'var', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (true) { const nt = this.peek()!; if (nt.kind === 'punct' && nt.value === ']') { this.next(); break; } items.push(this.parseValue()); }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, Value> = {};
      while (true) {
        const nt = this.peek()!;
        if (nt.kind === 'punct' && nt.value === '}') { this.next(); break; }
        const k = this.next().value;
        this.expectPunct(':');
        fields[k] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

function evalValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': case 'enum': return v.value;
    case 'int': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((x) => evalValue(x, vars));
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v.fields)) o[k] = evalValue(x, vars); return o; }
  }
}

// ---------------------------------------------------------------- schema (for validation + introspection)
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Viewer: ['login', 'id', 'name', 'email'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'htmlUrl', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'mergedAt', 'mergeCommitSha', 'headRef', 'baseRef', 'author'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Node: ['id'],
};
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'WIKI'];

// The GraphQL return type of each field, for validation of nested selections.
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'Viewer', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { author: 'User' },
  PullRequest: { files: 'PullRequestChangedFileConnection', author: 'User' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
};

function validate(sels: Selection[], type: string, errors: string[]): void {
  const fields = TYPE_FIELDS[type];
  if (!fields) return;
  for (const s of sels) {
    if (s.fragment) {
      const t = s.typeCondition ?? type;
      if (t === type || t === 'Node' || type === 'Node') validate(s.selections, t === 'Node' ? type : t, errors);
      else validate(s.selections, t, errors);
      continue;
    }
    if (s.name.startsWith('__')) {
      if (!fields.includes(s.name)) errors.push(`Cannot query field "${s.name}" on type "${type}".`);
      else if (s.selections.length) validate(s.selections, FIELD_TYPE[type]?.[s.name] ?? s.name, errors);
      continue;
    }
    if (!fields.includes(s.name)) { errors.push(`Cannot query field "${s.name}" on type "${type}".`); continue; }
    const child = FIELD_TYPE[type]?.[s.name];
    if (child && s.selections.length) validate(s.selections, child, errors);
  }
}

// ---------------------------------------------------------------- execution context
interface Ctx { store: Store; errors: string[]; }
type NodeVal =
  | { t: 'Viewer' }
  | { t: 'User'; login: string; id: number; name: string; email: string }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: { number: number; title: string; body: string; state: string; labels: string[]; seq: number } }
  | { t: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { t: 'IssueConnection'; nodes: NodeVal[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }; totalCount: number }
  | { t: 'PullRequestConnection'; nodes: NodeVal[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }; totalCount: number }
  | { t: 'PullRequestChangedFileConnection'; nodes: { path: string; filename: string; additions: number; deletions: number; changes: number; status: string }[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }; totalCount: number }
  | { t: 'Ref'; name: string }
  | { t: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }
  | { t: '__Type'; name: string }
  | { t: 'Payload'; kind: string; value: NodeVal | null }
  | { t: 'CommentEdge'; node: { id: string; body: string } }
  | { t: 'IssueComment'; id: string; body: string }
  | { t: 'Node'; value: NodeVal | null };

function cursorFor(seq: number): string { return Buffer.from(`cursor:${seq}`).toString('base64'); }
function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try { const m = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8')); return m ? Number(m[1]) : null; } catch { return null; }
}

function issueNode(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[]; seq: number }): NodeVal {
  return { t: 'Issue', repo, issue };
}
function prNode(repo: Repo, pr: PullRequest): NodeVal { return { t: 'PullRequest', repo, pr }; }

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): NodeVal {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const desc = orderBy?.direction === 'DESC' || (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC');
  list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
  const afterSeq = seqFromCursor(args.after);
  if (afterSeq !== null) list = list.filter((i) => (desc ? i.seq < afterSeq : i.seq > afterSeq));
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNext = first !== undefined && list.length > page.length;
  const last = page[page.length - 1];
  return {
    t: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: afterSeq !== null, endCursor: last ? cursorFor(last.seq) : null, startCursor: page[0] ? cursorFor(page[0].seq) : null },
    totalCount: repo.issues.size,
  };
}

function prsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): NodeVal {
  let list = [...repo.prs.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => want.has(p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED'));
  }
  list.sort((a, b) => b.seq - a.seq);
  const afterSeq = seqFromCursor(args.after);
  if (afterSeq !== null) list = list.filter((p) => p.seq < afterSeq);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNext = first !== undefined && list.length > page.length;
  const last = page[page.length - 1];
  return {
    t: 'PullRequestConnection',
    nodes: page.map((p) => prNode(repo, p)),
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: afterSeq !== null, endCursor: last ? cursorFor(last.seq) : null, startCursor: page[0] ? cursorFor(page[0].seq) : null },
    totalCount: repo.prs.size,
  };
}

function resolveField(ctx: Ctx, parent: NodeVal, sel: Selection, vars: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = evalValue(v, vars);
  const store = ctx.store;
  switch (parent.t) {
    case 'Viewer': {
      if (sel.name === 'login') return store.viewer.login;
      if (sel.name === 'id') return gid('User', store.viewer.id);
      if (sel.name === 'name') return store.viewer.name;
      if (sel.name === 'email') return store.viewer.email;
      return null;
    }
    case 'User': {
      if (sel.name === 'login') return parent.login;
      if (sel.name === 'id') return gid('User', parent.id);
      if (sel.name === 'name') return parent.name;
      if (sel.name === 'email') return parent.email;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (sel.name) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { t: 'User', login: repo.owner, id: repo.owner === store.viewer.login ? store.viewer.id : 0, name: repo.owner === store.viewer.login ? store.viewer.name : repo.owner, email: repo.owner === store.viewer.login ? store.viewer.email : '' } as NodeVal;
        case 'defaultBranchRef': { const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`); return tip ? ({ t: 'Ref', name: repo.defaultBranch } as NodeVal) : null; }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.priv;
        case 'issue': { const n = args.number as number; const issue = repo.issues.get(n); return issue ? issueNode(repo, issue) : null; }
        case 'issues': return issuesConnection(ctx, repo, args);
        case 'pullRequest': { const n = args.number as number; const pr = repo.prs.get(n); return pr ? prNode(repo, pr) : null; }
        case 'pullRequests': return prsConnection(ctx, repo, args);
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = parent;
      switch (sel.name) {
        case 'id': return gid('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'url': case 'htmlUrl': return '';
        case 'createdAt': case 'updatedAt': return FIXED_TS;
        case 'author': return { t: 'User', login: store.viewer.login, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email } as NodeVal;
        case 'labels': return issue.labels.map((l) => ({ name: l }));
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pr } = parent;
      switch (sel.name) {
        case 'id': return gid('PullRequest', repo.id, pr.number);
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
        case 'merged': return pr.merged;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return store.mergeable(repo, pr);
        case 'mergedAt': return pr.mergedAt;
        case 'mergeCommitSha': return pr.mergeCommitSha;
        case 'author': return { t: 'User', login: store.viewer.login, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email } as NodeVal;
        case 'files': {
          const files = store.prFiles(repo, pr).map((f) => ({ ...f, path: f.filename }));
          const first = typeof args.first === 'number' ? args.first : undefined;
          const page = first !== undefined ? files.slice(0, first) : files;
          return { t: 'PullRequestChangedFileConnection', nodes: page, pageInfo: { hasNextPage: first !== undefined && files.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null }, totalCount: files.length } as NodeVal;
        }
        default: return null;
      }
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      if (sel.name === 'nodes') return (parent as { nodes: unknown[] }).nodes;
      if (sel.name === 'pageInfo') return { t: 'PageInfo', ...(parent as { pageInfo: object }).pageInfo } as NodeVal;
      if (sel.name === 'totalCount') return (parent as { totalCount: number }).totalCount;
      return null;
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return parent.hasNextPage;
      if (sel.name === 'hasPreviousPage') return parent.hasPreviousPage;
      if (sel.name === 'endCursor') return parent.endCursor;
      if (sel.name === 'startCursor') return parent.startCursor;
      return null;
    }
    case 'Ref': return sel.name === 'name' ? parent.name : null;
    case '__Type': {
      if (sel.name === 'name') return parent.name;
      if (sel.name === 'kind') return parent.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (sel.name === 'description') return null;
      if (sel.name === 'fields') return (TYPE_FIELDS[parent.name] ?? []).map((n) => ({ name: n }));
      if (sel.name === 'enumValues') return parent.name === 'SearchType' ? SEARCH_ENUMS.map((n) => ({ name: n })) : [];
      return null;
    }
    case 'Payload': {
      if (sel.name === 'issue' || sel.name === 'pullRequest') return parent.value;
      if (sel.name === 'commentEdge') return parent.value;
      if (sel.name === 'clientMutationId') return null;
      return null;
    }
    case 'CommentEdge': {
      if (sel.name === 'node') return { t: 'IssueComment', id: parent.node.id, body: parent.node.body } as NodeVal;
      if (sel.name === 'cursor') return null;
      return null;
    }
    case 'IssueComment': {
      if (sel.name === 'id') return parent.id;
      if (sel.name === 'body') return parent.body;
      if (sel.name === 'createdAt') return FIXED_TS;
      if (sel.name === 'author') return { t: 'User', login: store.viewer.login, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email } as NodeVal;
      return null;
    }
    case 'Node': return parent.value;
  }
  return null;
}

function isNodeVal(v: unknown): v is NodeVal {
  return typeof v === 'object' && v !== null && 't' in (v as Record<string, unknown>);
}

function executeSelections(ctx: Ctx, parent: NodeVal, sels: Selection[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.fragment) {
      // inline fragment applies when the type condition matches the parent (or is Node)
      const cond = sel.typeCondition;
      const parentType = parent.t === 'Node' ? (parent.value?.t ?? '') : parent.t;
      const applies = !cond || cond === parentType || cond === 'Node' || parent.t === 'Node';
      if (!applies) continue;
      const effective: NodeVal = parent.t === 'Node' ? (parent.value ?? { t: 'Node', value: null }) : parent;
      if (parent.t === 'Node' && !parent.value) continue;
      Object.assign(out, executeSelections(ctx, effective, sel.selections, vars));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(ctx, parent, sel, vars);
    if (value === null || value === undefined) { out[key] = value ?? null; continue; }
    if (isNodeVal(value)) {
      out[key] = sel.selections.length ? executeSelections(ctx, value, sel.selections, vars) : null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isNodeVal(item)) return sel.selections.length ? executeSelections(ctx, item, sel.selections, vars) : null;
        if (typeof item === 'object' && item !== null && !('t' in item)) {
          // plain object (e.g. __Field {name}, label {name}, changed file {path})
          if (!sel.selections.length) return item;
          const o: Record<string, unknown> = {};
          for (const sub of sel.selections) {
            if (sub.fragment) continue;
            o[sub.alias ?? sub.name] = (item as Record<string, unknown>)[sub.name] ?? null;
          }
          return o;
        }
        return item;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- mutations
function runMutation(ctx: Ctx, op: Operation, vars: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    const input = (sel.args.input ? evalValue(sel.args.input, vars) : {}) as Record<string, unknown>;
    let payload: NodeVal | null = null;
    let err: string | null = null;
    if (sel.name === 'createIssue') {
      const decoded = typeof input.repositoryId === 'string' ? ungid(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
      if (!repo) err = 'Repository not found';
      else {
        const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) err = created.error;
        else payload = { t: 'Payload', kind: 'createIssue', value: issueNode(repo, created) };
      }
    } else if (sel.name === 'closeIssue') {
      const decoded = typeof input.issueId === 'string' ? ungid(input.issueId) : null;
      let found: { repo: Repo; issue: { number: number; title: string; body: string; state: string; labels: string[]; seq: number } } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (!found) err = 'Issue not found';
      else { found.issue.state = 'closed'; payload = { t: 'Payload', kind: 'closeIssue', value: issueNode(found.repo, found.issue) }; }
    } else if (sel.name === 'createPullRequest') {
      const decoded = typeof input.repositoryId === 'string' ? ungid(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
      if (!repo) err = 'Repository not found';
      else {
        const created = store.createPR(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
        if ('error' in created) err = created.error;
        else payload = { t: 'Payload', kind: 'createPullRequest', value: prNode(repo, created) };
      }
    } else if (sel.name === 'mergePullRequest') {
      const decoded = typeof input.pullRequestId === 'string' ? ungid(input.pullRequestId) : null;
      let found: { repo: Repo; pr: PullRequest } | null = null;
      if (decoded?.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const pr = repo?.prs.get(Number(decoded.parts[1]));
        if (repo && pr) found = { repo, pr };
      }
      if (!found) err = 'Pull request not found';
      else {
        const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase() === 'MERGE' ? 'merge' : 'squash';
        const res = store.mergePR(found.repo, found.pr, method);
        if ('error' in res) err = res.error;
        payload = { t: 'Payload', kind: 'mergePullRequest', value: prNode(found.repo, found.pr) };
      }
    } else if (sel.name === 'addComment') {
      const decoded = typeof input.subjectId === 'string' ? ungid(input.subjectId) : null;
      let found: { repo: Repo; num: number } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        if (repo && repo.issues.has(Number(decoded.parts[1]))) found = { repo, num: Number(decoded.parts[1]) };
      }
      if (!found) err = 'Subject not found';
      else {
        const c = store.createComment(found.repo, found.num, String(input.body ?? ''));
        if ('error' in c) err = c.error;
        else payload = { t: 'Payload', kind: 'addComment', value: { t: 'CommentEdge', node: { id: gid('IssueComment', found.repo.id, found.num, c.id), body: c.body } } };
      }
    } else {
      err = `Unknown mutation "${sel.name}"`;
    }
    if (err) ctx.errors.push(err);
    const key = sel.alias ?? sel.name;
    if (payload && sel.selections.length) out[key] = executeSelections(ctx, payload, sel.selections, vars);
    else if (payload) out[key] = {};
    else out[key] = null;
  }
  return out;
}

function runQuery(ctx: Ctx, op: Operation, vars: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    const key = sel.alias ?? sel.name;
    if (sel.fragment) continue;
    if (sel.name === '__type') {
      const name = sel.args.name ? String(evalValue(sel.args.name, vars) ?? '') : '';
      const node: NodeVal = TYPE_FIELDS[name] || name === 'SearchType' ? { t: '__Type', name } : { t: '__Type', name };
      if (!TYPE_FIELDS[name] && name !== 'SearchType') { out[key] = null; continue; }
      out[key] = sel.selections.length ? executeSelections(ctx, node, sel.selections, vars) : { name };
      continue;
    }
    if (sel.name === '__schema') { out[key] = sel.selections.length ? { types: [] } : {}; continue; }
    if (sel.name === 'viewer') {
      const node: NodeVal = { t: 'Viewer' };
      out[key] = sel.selections.length ? executeSelections(ctx, node, sel.selections, vars) : {};
      continue;
    }
    if (sel.name === 'repository') {
      const owner = String(evalValue(sel.args.owner, vars) ?? '');
      const name = String(evalValue(sel.args.name, vars) ?? '');
      const repo = store.getRepo(owner, name);
      if (!repo || repo.owner.toLowerCase() !== owner.toLowerCase()) { out[key] = null; continue; }
      const node: NodeVal = { t: 'Repository', repo };
      out[key] = sel.selections.length ? executeSelections(ctx, node, sel.selections, vars) : {};
      continue;
    }
    if (sel.name === 'node') {
      const id = String(evalValue(sel.args.id, vars) ?? '');
      const decoded = ungid(id);
      let value: NodeVal | null = null;
      if (decoded?.kind === 'Repository') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        if (repo) value = { t: 'Repository', repo };
      } else if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (repo && issue) value = issueNode(repo, issue);
      } else if (decoded?.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const pr = repo?.prs.get(Number(decoded.parts[1]));
        if (repo && pr) value = prNode(repo, pr);
      }
      const nodeVal: NodeVal = { t: 'Node', value };
      if (!value) { out[key] = null; continue; }
      // node selections may include `id` directly and inline fragments
      const tmp: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.fragment) {
          const cond = sub.typeCondition;
          const applies = !cond || cond === value.t || cond === 'Node';
          if (applies) Object.assign(tmp, executeSelections(ctx, value, sub.selections, vars));
          continue;
        }
        if (sub.name === 'id') tmp[sub.alias ?? 'id'] = resolveField(ctx, value, sub, vars);
        else tmp[sub.alias ?? sub.name] = null;
      }
      out[key] = tmp;
      void nodeVal;
      continue;
    }
    ctx.errors.push(`Cannot query field "${sel.name}" on type "Query".`);
    out[key] = null;
  }
  return out;
}

/** Execute one GraphQL operation body. Returns the {data, errors?} envelope (or an array for batches). */
export type GqlResult = { data: unknown; errors?: { message: string }[] };
export function executeGraphQL(store: Store, body: unknown): GqlResult | GqlResult[] {
  const ctx: Ctx = { store, errors: [] };
  let ops: { query: string; variables?: Record<string, unknown>; operationName?: string }[];
  if (Array.isArray(body)) {
    return executeBatch(store, body);
  }
  if (typeof body !== 'object' || body === null) return { data: null, errors: [{ message: 'GraphQL body must be an object' }] };
  const rec = body as Record<string, unknown>;
  if (typeof rec.query !== 'string') return { data: null, errors: [{ message: 'GraphQL query must be a string' }] };
  ops = [{ query: rec.query, variables: (rec.variables as Record<string, unknown>) ?? {}, operationName: rec.operationName as string | undefined }];
  const op = ops[0]!;
  let parsed: Operation[];
  try { parsed = new Parser(op.query).parseDocument(); } catch (e) { return { data: null, errors: [{ message: `Syntax error: ${e instanceof Error ? e.message : String(e)}` }] }; }
  let chosen = parsed[0];
  if (op.operationName) chosen = parsed.find((p) => p.name === op.operationName) ?? parsed[0]!;
  if (!chosen) return { data: null, errors: [{ message: 'No operation found' }] };
  const vars = op.variables ?? {};
  const errors: string[] = [];
  validate(chosen.selections, chosen.kind === 'mutation' ? 'Mutation' : 'Query', errors);
  if (errors.length) return { data: null, errors: errors.map((m) => ({ message: m })) };
  const data = chosen.kind === 'mutation' ? runMutation(ctx, chosen, vars) : runQuery(ctx, chosen, vars);
  if (ctx.errors.length) return { data, errors: ctx.errors.map((m) => ({ message: m })) };
  return { data };
}

function executeBatch(store: Store, body: unknown[]): GqlResult[] {
  return body.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { data: null, errors: [{ message: 'Batch entry must be an object' }] };
    return executeGraphQL(store, entry) as GqlResult;
  });
}

export { peelToCommit };
