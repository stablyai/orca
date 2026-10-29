import { isFolderRepo } from '../repo-kind'
import type { Repo } from '../repo-types'
import type { RuntimeWorktreePsSummary } from '../runtime-worktree-contracts'
import { getWorktreeGitIdentityDisplay } from './git-identity-display'
import type { Worktree } from './types'

/** Share kind predicates between sidebar filters and host phone pushes to prevent visibility drift. */

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
  // Folder roots have no branch; empty branches on Git mains may be detached/offline and must stay visible.
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

/** Require a real HEAD as DetachedHeadBadge does; empty-branch folder/offline SSH rows are not detached checkouts. */
export function isDetachedHeadWorkspace(
  worktree: Pick<WorkspaceKindFields, 'branch' | 'head'>
): boolean {
  return getWorktreeGitIdentityDisplay(worktree)?.kind === 'detached'
}

export const WORKSPACE_KINDS = [
  'defaultBranch',
  'automationCreated',
  'cliCreated',
  'detachedHead'
] as const
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

export const WORKSPACE_KIND_SWITCH = {
  defaultBranch: 'hideDefaultBranchWorkspace',
  automationCreated: 'hideAutomationGeneratedWorkspaces',
  cliCreated: 'hideCliCreatedWorkspaces',
  detachedHead: 'hideDetachedHeadWorkspaces'
} as const satisfies Record<WorkspaceKind, string>

export type WorkspaceKindSwitches = Record<(typeof WORKSPACE_KIND_SWITCH)[WorkspaceKind], boolean>

/** Query only kinds whose hiding switch is on. */
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
