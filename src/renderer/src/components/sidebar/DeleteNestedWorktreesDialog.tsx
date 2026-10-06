import { useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'

export function DeleteNestedWorktreesDialog({
  target,
  worktreeName,
  onDeleted,
  dismissToast
}: {
  target: WorktreeRemovalTarget
  worktreeName: string
  onDeleted?: () => void
  dismissToast: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<GitWorktreeInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const request = useRef(0)

  const review = async (): Promise<void> => {
    const generation = ++request.current
    setOpen(true)
    setPlan(null)
    setError(null)
    try {
      const preview = window.api.worktrees.previewNestedRemoval
      if (!preview) {
        throw new Error('This host does not support nested worktree deletion.')
      }
      const result = await preview({
        worktreeId: target.id,
        hostId: target.executionHostId ?? undefined
      })
      if (generation === request.current) {
        setPlan(result)
      }
    } catch (failure) {
      if (generation === request.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
  }

  const remove = async (): Promise<void> => {
    if (!plan || deleting) {
      return
    }
    setDeleting(true)
    setError(null)
    const state = useAppStore.getState()
    const repoId = getRepoIdFromWorktreeId(target.id)
    const nestedRows = plan.slice(0, -1).flatMap((item) => {
      const row = getWorktreeOnHostFromState(
        state,
        `${repoId}::${item.path}`,
        target.executionHostId ?? undefined
      )
      return row ? [row] : []
    })
    state.markWorktreesDeleting(nestedRows)
    const commitFocus = prepareActiveWorktreeFocusAfterDelete(state.activeWorktreeId ?? target.id)
    try {
      const result = await state.removeWorktree(target, true, { approvedNestedWorktrees: plan })
      if (!result.ok) {
        setPlan(null)
        setError(result.error)
        return
      }
      setOpen(false)
      dismissToast()
      onDeleted?.()
    } catch (failure) {
      setPlan(null)
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      try {
        await useAppStore.getState().fetchAllWorktrees()
        commitFocus()
      } catch (failure) {
        toast.error(
          translate('worktree.nestedRemoval.refreshFailed', 'Could not refresh the workspace list'),
          {
            description: failure instanceof Error ? failure.message : String(failure)
          }
        )
      }
      for (const row of nestedRows) {
        useAppStore.getState().clearWorktreeDeleteState(row.id, row.hostId)
      }
      setDeleting(false)
    }
  }

  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => void review()}>
        {translate('worktree.nestedRemoval.review', 'Delete with nested worktrees…')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (deleting) {
            return
          }
          ++request.current
          setOpen(next)
        }}
      >
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>
              {translate('worktree.nestedRemoval.title', 'Delete workspace and nested worktrees?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'worktree.nestedRemoval.description',
                'This permanently deletes "{{name}}", every nested worktree listed below, and all files inside them, including uncommitted changes. Their terminals and agents will be stopped.',
                { name: worktreeName }
              )}
            </DialogDescription>
          </DialogHeader>
          {plan ? (
            <div className="rounded-md border border-border/70 bg-muted/35 text-xs">
              <ScrollArea className="h-48">
                <div className="space-y-1 px-3 py-2" role="list">
                  {plan.map((item) => (
                    <div
                      key={item.path}
                      role="listitem"
                      className="min-w-0 border-b border-border/50 py-1 last:border-0"
                    >
                      <div className="break-all font-medium text-foreground">
                        {item.branch.replace(/^refs\/heads\//, '') ||
                          translate('worktree.nestedRemoval.detached', 'Detached HEAD')}
                      </div>
                      <div className="mt-0.5 break-all text-muted-foreground">{item.path}</div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : !error ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {translate('worktree.nestedRemoval.loading', 'Checking nested worktrees…')}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {translate(
              'worktree.nestedRemoval.order',
              'Nested worktrees are deleted first. If one fails, deletion stops and the parent is kept. Branches follow your existing deletion settings.'
            )}
          </p>
          {error ? (
            <p role="alert" className="break-all text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => {
                ++request.current
                setOpen(false)
              }}
            >
              {translate('worktree.nestedRemoval.cancel', 'Cancel')}
            </Button>
            {error && !plan ? (
              <Button variant="outline" onClick={() => void review()}>
                {translate('worktree.nestedRemoval.retry', 'Review again')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={!plan || deleting}
                onClick={() => void remove()}
              >
                {deleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {deleting
                  ? translate('worktree.nestedRemoval.deleting', 'Deleting…')
                  : translate('worktree.nestedRemoval.confirm', 'Delete all listed worktrees')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
