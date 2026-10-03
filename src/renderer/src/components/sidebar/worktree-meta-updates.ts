import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import {
  buildLinearIssueLinkUpdates,
  LINEAR_ISSUE_LINK_CLEARED
} from '../../../../shared/linear/links'
import { parseIssueLinkInput, type IssueLinkProvider } from '../../../../shared/issue-link-input'
import type { WorkspaceSourceProvider } from '../../../../shared/new-workspace/workspace-source'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'
import { parseBareItemNumber } from '../../../../shared/work-item-number'
import type { HostedReviewCreationProvider } from '../../../../shared/hosted-review-creation-providers'

/** The five real forges. Only github and gitlab have an editor; the other three
 *  resolve so the row can name them rather than mislabel them GitHub. */
export type WorktreeReviewProvider = HostedReviewCreationProvider

export type EditableWorktreeReviewProvider = Extract<WorktreeReviewProvider, 'github' | 'gitlab'>

export function isEditableReviewProvider(
  provider: WorktreeReviewProvider | null | undefined
): provider is EditableWorktreeReviewProvider {
  return provider === 'github' || provider === 'gitlab'
}

export type WorktreeMetaSavedPayload = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
}

/** What the user currently has typed in the dialog. */
export type WorktreeMetaDraft = {
  displayNameInput: string
  issueInput: string
  issueProvider: IssueLinkProvider
  reviewInput: string
  commentInput: string
}

/** The persisted state the dialog was seeded from. Captured once when the
 *  dialog opens: comparing a frozen draft against a live store would let a
 *  background write move the baseline and make an untouched field "dirty". */
export type WorktreeMetaSnapshot = {
  displayName: string
  comment: string
  issueInput: string
  issueProvider: IssueLinkProvider
  /** The persisted number in the slot of the provider being edited, or '' when
   *  empty. Not the seeded field value — the Checks panel deliberately seeds a
   *  review it has fetched but not yet linked, and Save must still write it. */
  reviewInput: string
  /** Stands in for an org key the typed value omits, so re-saving a stored bare
   *  identifier does not read as a change. */
  linkedLinearIssueOrganizationUrlKey?: string | null
}

/** The link state as it stands now, read at save time rather than at open.
 *  Displacement is decided against this: a CLI or background write that landed
 *  while the dialog was open must not survive a save the dialog warned would
 *  displace it, and a clear must not be emitted for a slot that is already empty
 *  — persistence gates the remote Linear capability on key presence, not value. */
export type WorktreeMetaLiveLinks = {
  linkedPR?: number | null
  linkedGitLabMR?: number | null
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedLinearIssue?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedWorkItemProvider?: WorkspaceSourceProvider | null
  /** `linkedWorkItem` also describes PRs and MRs, which this row does not own. */
  linkedWorkItemType?: WorkspaceLinkedItem['type'] | null
}

export function parseExplicitGitHubIssueUrl(input: string): string | null {
  const trimmed = input.trim()
  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link || link.type !== 'issue') {
    return null
  }

  return trimmed
}

export function parseGitHubWorkItemNumberForMetaField(
  input: string,
  expectedType: 'issue' | 'pr'
): number | null {
  const link = parseGitHubIssueOrPRLink(input)
  if (link) {
    // Why: issue and PR numbers live in separate GitHub namespaces for refs;
    // a URL path mismatch must not silently link the other field.
    return link.type === expectedType ? link.number : null
  }

  return parseGitHubIssueOrPRNumber(input)
}

export function parseGitLabMergeRequestNumberForMetaField(input: string): number | null {
  const trimmed = input.trim()
  // Why: `!` is GitLab's MR sigil; `#` is GitHub's and stays rejected here.
  const bare = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed
  const direct = bare.startsWith('#') ? null : parseBareItemNumber(bare)
  if (direct !== null) {
    return direct
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  const link = parseGitLabIssueOrMRLink(trimmed)
  return link?.type === 'mr' && Number.isSafeInteger(link.number) && link.number > 0
    ? link.number
    : null
}

/** One entry per provider this row can edit. The three read-only forges have no
 *  link parser in src/shared, so adding one is: write a parser, add an entry. */
export const REVIEW_LINK_EDITORS: Record<
  EditableWorktreeReviewProvider,
  {
    parse: (input: string) => number | null
    write: (value: number | null) => Partial<WorktreeMeta>
  }
> = {
  github: {
    parse: (input) => parseGitHubWorkItemNumberForMetaField(input, 'pr'),
    write: (value) => ({ linkedPR: value })
  },
  gitlab: {
    parse: parseGitLabMergeRequestNumberForMetaField,
    write: (value) => ({ linkedGitLabMR: value })
  }
}

// Why: blanking the field means "fall back to the branch/folder name", and the
// empty string is how that intent is persisted. Emitting `undefined` instead
// put a present-but-undefined key into the store spread, wiping the live name
// and crashing the worktree palette (crash a1f81ea1).
function buildDisplayNameUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): Partial<WorktreeMeta> {
  const trimmed = draft.displayNameInput.trim()
  return trimmed === current.displayName ? {} : { displayName: trimmed }
}

// Why: persistence bumps lastActivityAt whenever a `comment` key is present, so
// re-emitting an unchanged note reorders the workspace under the time-decay
// sidebar sort on a save that only touched the issue link.
function buildCommentUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): Partial<WorktreeMeta> {
  const trimmed = draft.commentInput.trim()
  return trimmed === current.comment ? {} : { comment: trimmed }
}

/** Which issue a value names, ignoring spelling: `42` and `#42` are one GitHub
 *  link, `sta-335`, `STA-335` and its linear.app URL are one Linear link. A
 *  Linear URL still refines a
 *  stored org key, so the key belongs to the identity — with the stored one
 *  standing in when the input omits it. Unparseable text compares as raw text:
 *  there is nothing to normalize, and the builder writes nothing for it anyway. */
function issueLinkIdentity(
  input: string,
  provider: IssueLinkProvider,
  storedLinearOrganizationUrlKey: string | null
): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    return ''
  }
  const parsed = parseIssueLinkInput(trimmed, provider)
  if (!parsed) {
    return `raw:${provider}:${trimmed}`
  }
  if (parsed.provider === 'github' || parsed.provider === 'gitlab') {
    return `${parsed.provider}:${parsed.number}`
  }
  const organizationUrlKey = parsed.organizationUrlKey ?? storedLinearOrganizationUrlKey ?? ''
  return `linear:${parsed.identifier}:${organizationUrlKey.trim().toLowerCase()}`
}

// Why: normalized identity rather than trimmed text. Retyping the same issue in
// another spelling — `42` to `#42`, `STA-335` to its URL — would otherwise enter
// the displacement path and clear the title and source context of the very link
// it re-states. A provider switch is only visible through the identity when
// there is a value to reinterpret, which is the intent an empty field lacks.
export function isIssueFieldDirty(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): boolean {
  const storedOrganizationUrlKey = current.linkedLinearIssueOrganizationUrlKey ?? null
  return (
    issueLinkIdentity(draft.issueInput, draft.issueProvider, storedOrganizationUrlKey) !==
    issueLinkIdentity(current.issueInput, current.issueProvider, storedOrganizationUrlKey)
  )
}

/** Whether the value being saved names the very issue `linkedWorkItem` already
 *  describes. Org keys only disagree when both are known: a stored link without
 *  one is not evidence of a different organization, so a URL that supplies it
 *  refines the link rather than replacing it. */
function keepsLinkedWorkItem(
  input: string,
  provider: IssueLinkProvider,
  live: WorktreeMetaLiveLinks
): boolean {
  const parsed = parseIssueLinkInput(input.trim(), provider)
  if (!parsed || live.linkedWorkItemType !== 'issue') {
    return false
  }
  if (parsed.provider === 'github') {
    return live.linkedWorkItemProvider === 'github' && parsed.number === live.linkedIssue
  }
  if (parsed.provider === 'gitlab') {
    return live.linkedWorkItemProvider === 'gitlab' && parsed.number === live.linkedGitLabIssue
  }
  if (
    live.linkedWorkItemProvider !== 'linear' ||
    parsed.identifier.toUpperCase() !== live.linkedLinearIssue?.trim().toUpperCase()
  ) {
    return false
  }
  const storedOrganizationUrlKey = live.linkedLinearIssueOrganizationUrlKey?.trim()
  const nextOrganizationUrlKey = parsed.organizationUrlKey?.trim()
  return (
    !storedOrganizationUrlKey ||
    !nextOrganizationUrlKey ||
    storedOrganizationUrlKey.toLowerCase() === nextOrganizationUrlKey.toLowerCase()
  )
}

/** Owns both provider slot families. One issue per workspace: writing one
 *  provider clears the other. Emits nothing at all unless the field changed —
 *  the dialog opens focused on Comment, so an untouched field must never
 *  destroy a link the user came here to keep. */
function buildIssueLinkUpdates(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks
): Partial<WorktreeMeta> {
  if (!isIssueFieldDirty(draft, current)) {
    return {}
  }

  const trimmed = draft.issueInput.trim()
  // Why: the linked work item and its source context describe the issue being
  // replaced. Leaving them would keep a stale title badge and mis-scope Linear
  // reads — but only when the save names a *different* issue: a value that
  // re-states the same one, such as a URL adding an org key, must keep its own
  // title and SSH/runtime routing context. Narrow on purpose: `type` because the
  // field also records the PR or MR a workspace was created from, and provider
  // because Jira issues still have no slot in this row — displacing what it
  // cannot display would destroy a link the user was never shown and has no
  // other editor to restore it from. GitHub, GitLab and Linear all have one.
  const displacedWorkItem: Partial<WorktreeMeta> =
    !keepsLinkedWorkItem(trimmed, draft.issueProvider, live) &&
    (live.linkedWorkItemProvider === 'github' ||
      live.linkedWorkItemProvider === 'gitlab' ||
      live.linkedWorkItemProvider === 'linear') &&
    live.linkedWorkItemType === 'issue'
      ? { linkedWorkItem: null, linkedTaskSourceContext: null }
      : {}

  // Why: persistence gates the remote Linear capability on key presence, not
  // value. A synthetic clear on a workspace that never held a Linear link would
  // fail a GitHub-only save against an older runtime, citing Linear. Read live,
  // not from the snapshot: a link added since the dialog opened would otherwise
  // outlive a save that just promised to displace it.
  const displacedLinear: Partial<WorktreeMeta> = live.linkedLinearIssue
    ? LINEAR_ISSUE_LINK_CLEARED
    : {}

  // Why: same presence gate as Linear — never emit a clear for a slot that was
  // already empty, so a payload against an older runtime stays minimal and the
  // remote capability gate in worktree-meta-persist does not fire needlessly.
  const displacedGitLab: Partial<WorktreeMeta> =
    typeof live.linkedGitLabIssue === 'number' ? { linkedGitLabIssue: null } : {}

  if (trimmed === '') {
    return {
      linkedIssue: null,
      ...displacedGitLab,
      ...displacedLinear,
      ...displacedWorkItem
    }
  }

  const parsed = parseIssueLinkInput(trimmed, draft.issueProvider)
  if (!parsed) {
    // Why: unparseable input leaves every link untouched. `canSave` already
    // blocks this path, but the builder stays pure rather than relying on it.
    return {}
  }

  if (parsed.provider === 'github') {
    return {
      linkedIssue: parsed.number,
      ...displacedGitLab,
      ...displacedLinear,
      ...displacedWorkItem
    }
  }

  if (parsed.provider === 'gitlab') {
    return {
      linkedGitLabIssue: parsed.number,
      linkedIssue: null,
      ...displacedLinear,
      ...displacedWorkItem
    }
  }

  const linearUpdates = buildLinearIssueLinkUpdates(trimmed)
  return linearUpdates
    ? { linkedIssue: null, ...displacedGitLab, ...linearUpdates, ...displacedWorkItem }
    : {}
}

function buildReviewLinkUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks,
  provider: WorktreeReviewProvider | null
): Partial<WorktreeMeta> {
  if (!isEditableReviewProvider(provider)) {
    return {}
  }
  const trimmed = draft.reviewInput.trim()
  // Why: for every provider, not only GitHub. An untouched MR field used to
  // re-emit linkedGitLabMR on comment-only saves.
  if (trimmed === current.reviewInput.trim()) {
    return {}
  }
  const editor = REVIEW_LINK_EDITORS[provider]
  if (trimmed === '') {
    return {
      ...editor.write(null),
      ...(provider === 'github' && typeof live.linkedPR === 'number'
        ? { suppressedGitHubPR: live.linkedPR }
        : {})
    }
  }
  const number = editor.parse(trimmed)
  return number === null ? {} : editor.write(number)
}

/** Pure save-payload builder for the worktree meta dialog: empty inputs clear
 *  the link (null), unparseable inputs leave it untouched (omitted). No key is
 *  ever emitted holding `undefined` — persistence raw-spreads updates, so a
 *  present-but-undefined key erases the stored value. */
export function buildWorktreeMetaUpdates(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks,
  // Why: null means the provider is still resolving or has no editor. The review
  // row is inert then and must not write any slot.
  reviewProvider: WorktreeReviewProvider | null = 'github'
): Partial<WorktreeMeta> {
  return {
    ...buildCommentUpdate(draft, current),
    ...buildDisplayNameUpdate(draft, current),
    ...buildIssueLinkUpdates(draft, current, live),
    ...buildReviewLinkUpdate(draft, current, live, reviewProvider)
  }
}
