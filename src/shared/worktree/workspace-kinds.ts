import { isFolderRepo } from '../repo-kind'
import type { Repo } from '../repo-types'
import type { RuntimeWorktreePsSummary } from '../runtime-worktree-contracts'
import { getWorktreeGitIdentityDisplay } from './git-identity-display'
import type { Worktree } from './types'

/**
 * Predicates for what KIND of workspace a row is, as the sidebar's Filters switches classify it.
 *
 * Why shared: main applies the persisted switches to the phone push it sends for local chat
 * sessions, and a second copy of these predicates is how that push drifts from the sidebar.
 */

type WorkspaceKindFields = Pick<
  Worktree,
  | 'isMainWorktree'
  | 'branch'
  | 'head'
  | 'ephemeralVmCheckoutMode'
  | 'automationProvenance'
  | 'cliProvenance'
>

/** Keeps provisioned roots visible because they are the recipe-created workspace, not a source-repo row. */
export function isDefaultBranchWorkspace(
  worktree: Pick<WorkspaceKindFields, 'isMainWorktree' | 'branch' | 'ephemeralVmCheckoutMode'>,
  repo: Pick<Repo, 'kind'> | undefined
): boolean {
  if (!worktree.isMainWorktree || worktree.ephemeralVmCheckoutMode === 'provisioned-root') {
    return false
  }
  // Why: a folder project's root is its default workspace but has no branch; on a git repo an
  // empty branch means detached HEAD or an offline SSH row, which stay visible.
  return worktree.branch.trim() !== '' || (repo !== undefined && isFolderRepo(repo))
}

export function isAutomationGeneratedWorkspace(
  worktree: Pick<WorkspaceKindFields, 'automationProvenance'>
): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(
  worktree: Pick<WorkspaceKindFields, 'cliProvenance'>
): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

/**
 * Whether a worktree sits on a detached HEAD (a commit, not a branch).
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an
 * empty branch and an empty head, so branch-emptiness alone would sweep them
 * into this filter. Requiring a real head keeps the predicate to genuine
 * detached-HEAD checkouts, matching what DetachedHeadBadge renders on the card.
 */
export function isDetachedHeadWorkspace(
  worktree: Pick<WorkspaceKindFields, 'branch' | 'head'>
): boolean {
  return getWorktreeGitIdentityDisplay(worktree)?.kind === 'detached'
}

/** The workspace kinds a Filters switch can hide. */
export const WORKSPACE_KINDS = [
  'defaultBranch',
  'automationCreated',
  'cliCreated',
  'detachedHead'
] as const
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/** Which Filters switch hides each kind: the one list every surface applies. */
export const WORKSPACE_KIND_SWITCH = {
  defaultBranch: 'hideDefaultBranchWorkspace',
  automationCreated: 'hideAutomationGeneratedWorkspaces',
  cliCreated: 'hideCliCreatedWorkspaces',
  detachedHead: 'hideDetachedHeadWorkspaces'
} as const satisfies Record<WorkspaceKind, string>

/** The Filters switches that hide a workspace by its kind alone, with no live renderer state. */
export type WorkspaceKindSwitches = Record<(typeof WORKSPACE_KIND_SWITCH)[WorkspaceKind], boolean>

/** Whether a switch that is on hides a kind this row is; `isKind` is asked only for those kinds. */
export function isHiddenByKindSwitch(
  switches: WorkspaceKindSwitches,
  isKind: (kind: WorkspaceKind) => boolean
): boolean {
  return WORKSPACE_KINDS.some((kind) => switches[WORKSPACE_KIND_SWITCH[kind]] && isKind(kind))
}

const KIND_PREDICATES: Record<
  WorkspaceKind,
  (worktree: WorkspaceKindFields, repo: Pick<Repo, 'kind'> | undefined) => boolean
> = {
  defaultBranch: isDefaultBranchWorkspace,
  automationCreated: isAutomationGeneratedWorkspace,
  cliCreated: isCliCreatedWorkspace,
  detachedHead: isDetachedHeadWorkspace
}

export function isHiddenByWorkspaceKindSwitch(
  worktree: WorkspaceKindFields,
  repo: Pick<Repo, 'kind'> | undefined,
  switches: WorkspaceKindSwitches
): boolean {
  return isHiddenByKindSwitch(switches, (kind) => KIND_PREDICATES[kind](worktree, repo))
}

/** What a host stamps on each worktree.ps row, so a phone's filters match this host's sidebar. */
export function getWorkspaceRowKindFacts(
  worktree: WorkspaceKindFields,
  repo: Pick<Repo, 'kind'> | undefined
): Pick<
  RuntimeWorktreePsSummary,
  'defaultBranch' | 'automationCreated' | 'automationName' | 'cliCreated' | 'detachedHead'
> {
  // Persisted provenance is not validated, so an older record may lack the snapshot.
  const snapshot: unknown = worktree.automationProvenance?.automationNameSnapshot
  const automationName = typeof snapshot === 'string' ? snapshot.trim() : ''
  return {
    defaultBranch: isDefaultBranchWorkspace(worktree, repo),
    ...(isAutomationGeneratedWorkspace(worktree)
      ? { automationCreated: true, ...(automationName ? { automationName } : {}) }
      : {}),
    ...(isCliCreatedWorkspace(worktree) ? { cliCreated: true } : {}),
    ...(isDetachedHeadWorkspace(worktree) ? { detachedHead: true } : {})
  }
}
