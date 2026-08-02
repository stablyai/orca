import { Workflow } from 'lucide-react'
import type { JSX } from 'react'
import type { Worktree } from '../../../../shared/types'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import { translate } from '@/i18n/i18n'

type DeleteWorktreeLineageNoticeProps = {
  descendants: readonly Worktree[]
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
}

export function DeleteWorktreeLineageNotice({
  descendants,
  dirtyChangeCountsByWorktreeId
}: DeleteWorktreeLineageNoticeProps): JSX.Element | null {
  const childWorkspaceCount = descendants.length
  if (childWorkspaceCount === 0) {
    return null
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Workflow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {translate(
              'auto.components.sidebar.DeleteWorktreeLineageNotice.a940f3c96e',
              'Child workspaces will be deleted'
            )}
          </div>
          <div className="mt-1 text-muted-foreground">
            {childWorkspaceCount === 1
              ? translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.66798cc6a2',
                  'Deleting this workspace also deletes 1 child workspace.'
                )
              : translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.29b98bf9cd',
                  'Deleting this workspace also deletes {{value0}} child workspaces.',
                  { value0: childWorkspaceCount }
                )}
          </div>
          {/* Why: long nowrap paths can otherwise give this grid child an
             intrinsic width wider than the modal. */}
          <div className="mt-2 min-w-0 max-w-full space-y-1 overflow-hidden rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
            {descendants.slice(0, 4).map((child) => (
              <div key={child.id} className="min-w-0 overflow-hidden">
                <div className="truncate font-medium text-foreground">{child.displayName}</div>
                <div className="truncate text-muted-foreground">{child.path}</div>
                <DeleteWorktreeDirtyChangeHint
                  changeCount={dirtyChangeCountsByWorktreeId.get(child.id)}
                />
              </div>
            ))}
            {descendants.length > 4 ? (
              <div className="text-muted-foreground">
                +{descendants.length - 4}{' '}
                {translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.ad407c2d55',
                  'more'
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
