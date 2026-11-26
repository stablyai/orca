import type { ExecutionHostId } from '../execution-host/execution-host'

export type NgitWorkItemState = 'open' | 'draft' | 'merged' | 'closed'

export type NgitWorkItem = {
  id: string
  type: 'issue' | 'pr'
  /** First 32 bits of the event id; stable across machines. */
  number: number
  eventId: string
  title: string
  /** A resolved issue reads `closed`; `merged` is a PR's applied status. */
  state: NgitWorkItemState
  url: string
  labels: string[]
  createdAt: string
  updatedAt: string
  author: string
  authorAvatarUrl: string | null
  commentCount: number
  /** `branch-name` tag of a PR or patch series. */
  branchName?: string
  baseRefName?: string
  headSha?: string
  /** A patch series (kind 1617) rather than a pull request event (kind 1618). */
  isPatch?: boolean
  repoId: string
  repoHostId?: ExecutionHostId
}

export type NgitComment = {
  id: string
  author: string
  authorAvatarUrl: string | null
  body: string
  createdAt: string
  /** Set when the comment answers another comment rather than the item. */
  replyToId?: string
}

export type NgitPatch = {
  id: string
  commit?: string
  subject: string
  /** `git format-patch` text. */
  content: string
}

export type NgitWorkItemDetails = {
  item: NgitWorkItem
  body: string
  comments: NgitComment[]
  /** Patch series only. */
  patches: NgitPatch[]
  /** Where the PR's commits can be fetched from. */
  cloneUrls: string[]
  /** npubs allowed to merge. */
  maintainers: string[]
}

export type NgitWorkItemList = {
  /** Null when the repository is not an ngit repository. */
  repository: { identifier: string; name: string; webUrl: string } | null
  items: NgitWorkItem[]
}

export type NgitViewer = {
  /** False when the `ngit` CLI is missing, which leaves reads working and writes unavailable. */
  cliInstalled: boolean
  account: { npub: string; name: string | null } | null
}

export type NgitMutationResult = { ok: true } | { ok: false; error: string }

export type NgitWorktreeBaseResult =
  | { ok: true; baseBranch: string; workspaceName: string }
  | { ok: false; error: string }

export const NGIT_STATUS_ACTIONS = {
  issue: ['close', 'resolved', 'reopen'],
  pr: ['close', 'reopen', 'ready', 'draft', 'applied']
} as const

export type NgitStatusAction =
  (typeof NGIT_STATUS_ACTIONS)[keyof typeof NGIT_STATUS_ACTIONS][number]

export function ngitShortId(eventId: string): string {
  return eventId.slice(0, 8)
}
