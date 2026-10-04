import type { ParsedWorkspaceFilterQuery, WorkspaceFilterClause } from './workspace-filter-query'

/**
 * The fields a filter clause can read, flattened so worktrees and folder
 * workspaces evaluate through one predicate. Strings are matched as
 * case-insensitive substrings; flags answer `is:`.
 */
export type WorkspaceFilterSubject = {
  kind: 'worktree' | 'folder'
  name: string
  branch: string
  repoName: string
  repoPath: string
  hostId: string
  hostLabel: string
  path: string
  statusId: string
  statusLabel: string
  comment: string
  prNumbers: readonly number[]
  issueNumbers: readonly number[]
  pinned: boolean
  main: boolean
  sleeping: boolean
  detached: boolean
  cli: boolean
  automation: boolean
  unread: boolean
}

function includesAny(targets: readonly string[], values: readonly string[]): boolean {
  const folded = targets.map((target) => target.toLowerCase())
  return values.some((value) => folded.some((target) => target.includes(value)))
}

function numbersMatch(numbers: readonly number[], values: readonly string[]): boolean {
  return values.some((value) => {
    const parsed = Number.parseInt(value.replace(/^[#!]/, ''), 10)
    return Number.isFinite(parsed) && numbers.includes(parsed)
  })
}

function isValueHolds(subject: WorkspaceFilterSubject, value: string): boolean {
  switch (value) {
    case 'pinned':
      return subject.pinned
    case 'main':
      return subject.main
    case 'sleeping':
      return subject.sleeping
    case 'active':
      return !subject.sleeping
    case 'detached':
      return subject.detached
    case 'cli':
      return subject.cli
    case 'automation':
      return subject.automation
    case 'unread':
      return subject.unread
    case 'folder':
      return subject.kind === 'folder'
    default:
      return false
  }
}

function clauseHolds(subject: WorkspaceFilterSubject, clause: WorkspaceFilterClause): boolean {
  switch (clause.key) {
    case 'name':
      return includesAny([subject.name], clause.values)
    case 'repo':
      return includesAny([subject.repoName, subject.repoPath], clause.values)
    case 'branch':
      return includesAny([subject.branch], clause.values)
    case 'host':
      return includesAny([subject.hostId, subject.hostLabel], clause.values)
    case 'path':
      return includesAny([subject.path], clause.values)
    case 'status':
      return includesAny([subject.statusId, subject.statusLabel], clause.values)
    case 'is':
      return clause.values.some((value) => isValueHolds(subject, value))
    case 'pr':
      return numbersMatch(subject.prNumbers, clause.values)
    case 'issue':
      return numbersMatch(subject.issueNumbers, clause.values)
    case 'any':
      // Why: the positive `any:` text is resolved by the palette search upstream;
      // here only the substring fallback and negation are evaluated.
      return includesAny(
        [subject.name, subject.branch, subject.repoName, subject.hostLabel, subject.comment],
        clause.values
      )
  }
}

export type WorkspaceFilterTextVerdicts = {
  /** Rows the identity search accepted; null when the query has no free text. */
  identityMatched: ReadonlySet<string> | null
  /** Rows the widened `any:` search accepted; null when the query has no `any:`. */
  anyMatched: ReadonlySet<string> | null
}

/**
 * Whether one row survives the query. `rowKey` is the key the text verdict sets
 * use (host identity for worktrees). `anyFallback` lets callers without a
 * palette index (folder workspaces) fall back to substring matching for `any:`.
 */
export function workspaceMatchesFilterQuery(args: {
  parsed: ParsedWorkspaceFilterQuery
  subject: WorkspaceFilterSubject
  rowKey: string
  verdicts: WorkspaceFilterTextVerdicts
}): boolean {
  const { parsed, subject, rowKey, verdicts } = args
  if (!parsed.isActive) {
    return true
  }
  if (verdicts.identityMatched && !verdicts.identityMatched.has(rowKey)) {
    return false
  }
  for (const term of parsed.terms) {
    if (
      term.negated &&
      includesAny([subject.name, subject.branch, subject.repoName], [term.text.toLowerCase()])
    ) {
      return false
    }
  }
  for (const clause of parsed.clauses) {
    if (clause.key === 'any' && !clause.negated) {
      if (verdicts.anyMatched) {
        if (!verdicts.anyMatched.has(rowKey)) {
          return false
        }
        continue
      }
      if (!clauseHolds(subject, clause)) {
        return false
      }
      continue
    }
    if (clauseHolds(subject, clause) === clause.negated) {
      return false
    }
  }
  return true
}
