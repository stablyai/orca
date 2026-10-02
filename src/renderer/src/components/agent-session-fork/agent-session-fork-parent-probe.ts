import { useAppStore } from '@/store'
import type { settingsForRepoOwner } from '@/store/repos/owner-routing'
import {
  findForkWorktreeRepo,
  forkWorktreeOwnerSettings
} from '@/lib/agent-session-fork-source-repo'
import type { AgentSessionForkBase } from '@/lib/agent-session-fork-flow'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { isWorkingTreeCarrySupported } from '@/runtime/runtime-git-working-tree-carry-client'
import type { GitStatusResult } from '../../../../shared/git-status-types'

export type AgentSessionForkCarryAvailability =
  | 'hidden'
  | 'available'
  | 'other-base'
  | 'unsupported'

export type ParentWorkingTreeChanges = { modified: number; added: number; headOid: string | null }

export type ParentProbe = {
  changes: Promise<ParentWorkingTreeChanges | null>
  carrySupported: Promise<boolean>
}

export type ForkSourceSnapshot = {
  worktree: { id: string; repoId: string; path: string } | null
  connectionId: string | null
  settings: ReturnType<typeof settingsForRepoOwner>
  parentBranch: string | null
  label: string
}

const HEAD_OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/

function shortBranchName(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  return trimmed ? trimmed.replace(/^refs\/heads\//, '') : null
}

export function readForkSource(sourceWorktreeId: string): ForkSourceSnapshot {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(sourceWorktreeId) ?? null
  const repo = worktree ? findForkWorktreeRepo(state, worktree) : null
  const parentBranch = shortBranchName(worktree?.branch)
  return {
    worktree,
    connectionId: repo?.connectionId ?? null,
    // Why: the same owner routing the fork flow uses, so status and carry probe the child's host.
    settings: worktree ? forkWorktreeOwnerSettings(state, worktree) : state.settings,
    parentBranch,
    label: worktree?.displayName?.trim() || parentBranch || sourceWorktreeId
  }
}

function countWorkingTreeChanges(status: GitStatusResult): ParentWorkingTreeChanges {
  const modified = new Set<string>()
  const added = new Set<string>()
  for (const entry of status.entries) {
    if (entry.area === 'untracked') {
      added.add(entry.path)
    } else {
      modified.add(entry.path)
    }
  }
  const head = status.head ?? ''
  return {
    modified: modified.size,
    added: added.size,
    headOid: HEAD_OID_PATTERN.test(head) ? head : null
  }
}

/** Reads the parent's HEAD and change counts on its host; resolves null instead of rejecting. */
export function readParentWorkingTreeChanges(
  source: ForkSourceSnapshot,
  signal: AbortSignal
): Promise<ParentWorkingTreeChanges | null> {
  const { worktree } = source
  if (!worktree) {
    return Promise.resolve(null)
  }
  return getRuntimeGitStatus(
    {
      settings: source.settings,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      connectionId: source.connectionId ?? undefined
    },
    { admissionTier: 'interactive', includeLineStats: false, signal }
  )
    .then(countWorkingTreeChanges)
    .catch((statusError: unknown) => {
      // Why: without a status the fork still works; it just starts clean at the parent branch.
      console.warn('[agent-session-fork] reading parent changes failed', statusError)
      return null
    })
}

/** Starts the parent's status and carry-capability reads; neither promise rejects. */
export function probeParentWorkingTree(
  source: ForkSourceSnapshot,
  signal: AbortSignal
): ParentProbe {
  if (!source.worktree) {
    return { changes: Promise.resolve(null), carrySupported: Promise.resolve(false) }
  }
  const carrySupported = isWorkingTreeCarrySupported(source.settings).catch(() => false)
  return { changes: readParentWorkingTreeChanges(source, signal), carrySupported }
}

export function resolveCarryAvailability(
  changes: ParentWorkingTreeChanges | null,
  carrySupported: boolean | null,
  base: AgentSessionForkBase
): AgentSessionForkCarryAvailability {
  // Why: wait for the capability probe so the switch never flips from enabled to disabled.
  if (!changes?.headOid || changes.modified + changes.added === 0 || carrySupported === null) {
    return 'hidden'
  }
  if (base.kind !== 'parent-commit') {
    return 'other-base'
  }
  return carrySupported ? 'available' : 'unsupported'
}
