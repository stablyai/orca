import type { JSX } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Worktree } from '../../../../shared/types'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'

type DeleteState = {
  isDeleting?: boolean
  error?: string | null
}

export function DeleteWorktreeTargetPreview({
  isBatchDelete,
  worktree,
  worktrees,
  deleteStateByWorktreeId,
  dirtyChangeCountsByWorktreeId
}: {
  isBatchDelete: boolean
  worktree: Worktree | null
  worktrees: readonly Worktree[]
  deleteStateByWorktreeId: Record<string, DeleteState | undefined>
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
}): JSX.Element | null {
  if (isBatchDelete) {
    return (
      <ScrollArea className="max-h-48 rounded-md border border-border/70 bg-muted/35 text-xs">
        <div className="space-y-1 px-3 py-2">
          {worktrees.map((item) => {
            const itemDeleteState = deleteStateByWorktreeId[item.id]
            return (
              <div key={item.id} className="min-w-0 border-b border-border/50 py-1 last:border-0">
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-medium text-foreground">{item.displayName}</div>
                    <div className="mt-0.5 break-all text-muted-foreground">{item.path}</div>
                    <DeleteWorktreeDirtyChangeHint
                      changeCount={dirtyChangeCountsByWorktreeId.get(item.id)}
                    />
                    {itemDeleteState?.error ? (
                      <div className="mt-1 whitespace-pre-wrap break-all text-destructive">
                        {itemDeleteState.error}
                      </div>
                    ) : null}
                  </div>
                  {itemDeleteState?.isDeleting ? (
                    <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    )
  }

  return worktree ? (
    <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
      <div className="break-all font-medium text-foreground">{worktree.displayName}</div>
      <div className="mt-1 break-all text-muted-foreground">{worktree.path}</div>
      <DeleteWorktreeDirtyChangeHint changeCount={dirtyChangeCountsByWorktreeId.get(worktree.id)} />
    </div>
  ) : null
}
