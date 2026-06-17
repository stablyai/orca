import React, { useCallback, useMemo, useState } from 'react'
import { FolderOpen, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import type { RuntimeAgentSessionForkRemoveResult } from '../../../../shared/runtime-types'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'

type ManagedForkWorkspace = {
  worktree: Worktree
  lineage: WorktreeLineage
  createdAt: number
}

type Props = {
  open: boolean
  parentWorktree: Worktree
  forks: readonly ManagedForkWorkspace[]
  onOpenChange: (open: boolean) => void
}

function getForkLabel(worktree: Worktree): string {
  return worktree.displayName || worktree.branch || worktree.path || worktree.id
}

function formatForkCreatedAt(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return translate('auto.components.sidebar.WorktreeForkManagementDialog.unknownTime', 'Unknown')
  }
  return new Date(createdAt).toLocaleString()
}

const WorktreeForkManagementDialog = React.memo(function WorktreeForkManagementDialog({
  open,
  parentWorktree,
  forks,
  onOpenChange
}: Props) {
  const confirm = useConfirmationDialog()
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const [removingForkId, setRemovingForkId] = useState<string | null>(null)
  const parentLabel = getForkLabel(parentWorktree)
  const sortedForks = useMemo(
    () =>
      [...forks].sort(
        (a, b) => b.createdAt - a.createdAt || a.worktree.id.localeCompare(b.worktree.id)
      ),
    [forks]
  )

  const handleOpenFork = useCallback(
    (worktreeId: string) => {
      onOpenChange(false)
      activateAndRevealWorktree(worktreeId)
    },
    [onOpenChange]
  )

  const handleRemoveFork = useCallback(
    async (fork: ManagedForkWorkspace) => {
      if (removingForkId) {
        return
      }
      const confirmed = await confirm({
        title: translate(
          'auto.components.sidebar.WorktreeForkManagementDialog.removeTitle',
          'Remove Fork'
        ),
        description: translate(
          'auto.components.sidebar.WorktreeForkManagementDialog.removeDescription',
          'Orca will ask the runtime to remove this child workspace. Dirty worktrees are not removed.'
        ),
        confirmLabel: translate(
          'auto.components.sidebar.WorktreeForkManagementDialog.removeConfirm',
          'Remove'
        ),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      setRemovingForkId(fork.worktree.id)
      try {
        const state = useAppStore.getState()
        const runtimeTarget = getActiveRuntimeTarget(
          getSettingsForWorktreeRuntimeOwner(state, fork.worktree.id)
        )
        await callRuntimeRpc<RuntimeAgentSessionForkRemoveResult>(
          runtimeTarget,
          'fork.rm',
          { fork: fork.worktree.id },
          { timeoutMs: 10 * 60_000 }
        )
        await fetchWorktrees(fork.worktree.repoId).catch(() => undefined)
        if (activeWorktreeId === fork.worktree.id) {
          activateAndRevealWorktree(parentWorktree.id, { sidebarRevealBehavior: 'auto' })
        }
        toast.success(
          translate(
            'auto.components.sidebar.WorktreeForkManagementDialog.removeSuccess',
            'Fork removed'
          )
        )
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.sidebar.WorktreeForkManagementDialog.removeFailed',
                'Failed to remove fork.'
              )
        )
      } finally {
        setRemovingForkId((current) => (current === fork.worktree.id ? null : current))
      }
    },
    [activeWorktreeId, confirm, fetchWorktrees, parentWorktree.id, removingForkId]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {translate(
              'auto.components.sidebar.WorktreeForkManagementDialog.title',
              'Manage Forks'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            <span className="font-medium text-foreground">{parentLabel}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1 scrollbar-sleek">
          {sortedForks.length === 0 ? (
            <div className="rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
              {translate(
                'auto.components.sidebar.WorktreeForkManagementDialog.empty',
                'No forks found.'
              )}
            </div>
          ) : (
            sortedForks.map((fork) => {
              const label = getForkLabel(fork.worktree)
              const removing = removingForkId === fork.worktree.id
              return (
                <div
                  key={fork.worktree.id}
                  className="rounded-md border border-border bg-card px-3 py-2 text-card-foreground"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="truncate text-sm font-medium">{label}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {fork.worktree.id}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {fork.worktree.path}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatForkCreatedAt(fork.createdAt)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => handleOpenFork(fork.worktree.id)}
                        disabled={removingForkId !== null}
                      >
                        <FolderOpen className="size-3" />
                        {translate(
                          'auto.components.sidebar.WorktreeForkManagementDialog.open',
                          'Open'
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="destructive"
                        onClick={() => void handleRemoveFork(fork)}
                        disabled={removingForkId !== null}
                      >
                        {removing ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                        {removing
                          ? translate(
                              'auto.components.sidebar.WorktreeForkManagementDialog.removing',
                              'Removing'
                            )
                          : translate(
                              'auto.components.sidebar.WorktreeForkManagementDialog.remove',
                              'Remove'
                            )}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.sidebar.WorktreeForkManagementDialog.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export { formatForkCreatedAt, getForkLabel }
export default WorktreeForkManagementDialog
