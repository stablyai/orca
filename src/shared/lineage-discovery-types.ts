export type LineageMatchSource = 'lineage' | 'pattern' | 'manual'
export type LineagePatternMatchOn = 'branch' | 'worktree-name' | 'both'

export type LineageDiscoverySettings = {
  lineageEnabled: boolean
  patternEnabled: boolean
  /** Regex source that extracts keys from the tower workspace name. */
  keyRegex: string
  matchOn: LineagePatternMatchOn
  /** 'all' or the repo ids that pattern discovery may scan. */
  repoScope: 'all' | string[]
}

export const DEFAULT_KEY_REGEX = '[A-Za-z][A-Za-z0-9]{1,9}-\\d+'

export const DEFAULT_LINEAGE_DISCOVERY: LineageDiscoverySettings = {
  lineageEnabled: true,
  patternEnabled: true,
  keyRegex: DEFAULT_KEY_REGEX,
  matchOn: 'branch',
  repoScope: 'all'
}

export type LineageManualLinkKind = 'pr' | 'branch' | 'worktree'

// invariant: kind absent means 'pr' (links saved before kinds); number is required for 'pr', branch for 'branch', worktreePath for 'worktree'
export type LineageManualLink = {
  id: string
  kind?: LineageManualLinkKind
  repoName: string
  repoId?: string
  number?: number
  url?: string
  // why: for 'pr' this is the head branch resolved once at add time, so a local worktree can match
  branch?: string
  worktreePath?: string
  worktreeId?: string
  addedAt: number
}

// why: compat alias for older imports; a manual link is no longer only a pull request
export type ManualPullRequestLink = LineageManualLink

export type LineageMemberPullRequest = {
  number: number
  url?: string
  title?: string
  /** Absent from older hosts and for `repo#n` references; rendered as `#n`. */
  provider?: 'github' | 'gitlab'
}

export type LineageMember = {
  repoName: string
  branch: string
  /** Absent for a manual PR that has no local worktree. */
  worktreePath?: string
  worktreeId?: string
  matchedBy: LineageMatchSource
  reasons: string[]
  pr?: LineageMemberPullRequest
  manualLinkId?: string
  /** The workspace whose members were asked for; absent from older hosts. */
  isTower?: boolean
  /** Remote (SSH) worktree this host cannot inspect; absent from older hosts. */
  unverifiable?: boolean
}
