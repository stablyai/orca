import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type {
  GitConflictOperation,
  GitStatusEntry,
  GitStatusResult
} from '../../../../../../shared/git/status/git-status-types'
import { copyOwnsStatusSlot, refreshWorktreeCopyStatus } from './workspace-branch-switch-status'

const NO_ENTRIES: GitStatusEntry[] = []

export type WorkspaceCopyStatus = {
  statusKnown: boolean
  statusReadError: string | undefined
  conflictOperation: GitConflictOperation
  entries: GitStatusEntry[]
}

type PrivateRead = { key: string; status?: GitStatusResult; error?: string }

/**
 * The picker's view of one copy's checkout. The owning copy uses the shared slots; a twin of
 * another selected copy reads its own status into picker state so neither copy sees the other's.
 */
export function useWorkspaceCopyStatus({
  worktreeId,
  worktreePath,
  hostId,
  open,
  refreshOnOpen
}: {
  worktreeId: string
  worktreePath: string
  hostId: ExecutionHostId
  open: boolean
  refreshOnOpen: boolean
}): WorkspaceCopyStatus {
  const owner = useAppStore((state) => copyOwnsStatusSlot(state, worktreeId, hostId))
  const head = useAppStore((state) =>
    owner ? state.gitStatusHeadByWorktree?.[worktreeId] : undefined
  )
  const slotReadError = useAppStore((state) =>
    owner ? state.gitStatusReadErrorByWorktree?.[worktreeId] : undefined
  )
  const slotConflict = useAppStore((state) =>
    owner ? state.gitConflictOperationByWorktree[worktreeId] : undefined
  )
  const slotEntries = useAppStore((state) =>
    owner ? state.gitStatusByWorktree[worktreeId] : undefined
  )
  const [read, setRead] = useState<PrivateRead | null>(null)
  // Selecting a copy doesn't clear the slots, so on becoming owner they may still hold the twin's
  // status; until they change, this copy reads its own status as a non-owner would.
  const [wasOwner, setWasOwner] = useState(owner)
  const [inherited, setInherited] = useState<{ head?: string; entries?: GitStatusEntry[] } | null>(
    null
  )
  if (owner !== wasOwner) {
    setWasOwner(owner)
    setInherited(owner ? { head, entries: slotEntries } : null)
  }
  const slotTrusted =
    owner && !(inherited && inherited.head === head && inherited.entries === slotEntries)
  const key = `${hostId}\u0000${worktreeId}\u0000${worktreePath}`
  useEffect(() => {
    if (!open) {
      return
    }
    if (owner && refreshOnOpen) {
      refreshWorktreeCopyStatus(worktreeId, hostId, worktreePath)
    }
    if (slotTrusted) {
      return
    }
    const copy = resolveWorktreeGitCopyNow(worktreeId, hostId)
    if (!copy) {
      return
    }
    let stale = false
    void getRuntimeGitStatus(
      { target: copy.transport, worktreeId, worktreePath, connectionId: copy.connectionId },
      { admissionTier: 'interactive' }
    ).then(
      (status) => {
        if (!stale) {
          setRead({ key, status })
        }
      },
      (error: unknown) => {
        if (!stale) {
          setRead({
            key,
            error:
              error instanceof Error
                ? error.message
                : translate(
                    'sourceControl.branchPicker.statusFailed',
                    "Orca couldn't read this checkout's changes. Refresh Source Control before switching."
                  )
          })
        }
      }
    )
    return () => {
      stale = true
    }
  }, [open, owner, slotTrusted, refreshOnOpen, worktreeId, hostId, worktreePath, key])
  if (slotTrusted) {
    return {
      statusKnown: head !== undefined,
      statusReadError: slotReadError,
      conflictOperation: slotConflict ?? 'unknown',
      entries: slotEntries ?? NO_ENTRIES
    }
  }
  const own = read?.key === key ? read : null
  return {
    statusKnown: own?.status !== undefined,
    // A failed status can come back as a result carrying readError rather than a rejection.
    statusReadError: own?.error ?? own?.status?.readError,
    conflictOperation: own?.status?.conflictOperation ?? 'unknown',
    entries: own?.status?.entries ?? NO_ENTRIES
  }
}
