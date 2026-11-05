// Why: one table drives the yaml key, the trust key and the default for both prompt templates,
// so adding a kind never means cloning the issue-command machinery.
export type RepoCommandKind = 'issue' | 'review'

// Doubles as the persisted trust key: it MUST match OrcaHookScriptKind, or an approval
// recorded under one name is looked up under another.
export const REPO_COMMAND_YAML_KEY = {
  issue: 'issueCommand',
  review: 'reviewCommand'
} as const satisfies Record<RepoCommandKind, string>

export const DEFAULT_REPO_COMMAND_TEMPLATE = {
  issue: 'Complete {{artifact_url}}',
  // Why: "review" is the verb for a pull/merge request the way "complete" is for an issue.
  review: 'Review {{artifact_url}}'
} as const satisfies Record<RepoCommandKind, string>

export function isRepoCommandKind(value: unknown): value is RepoCommandKind {
  return value === 'issue' || value === 'review'
}

export function getRepoCommandKindForLinkedItemType(
  type: 'issue' | 'pr' | 'mr' | undefined | null
): RepoCommandKind {
  return type === 'pr' || type === 'mr' ? 'review' : 'issue'
}
