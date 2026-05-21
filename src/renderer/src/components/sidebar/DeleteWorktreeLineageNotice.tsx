import { Workflow } from 'lucide-react'
import type { JSX } from 'react'
import type { Worktree } from '../../../../shared/types'

type DeleteWorktreeLineageNoticeProps = {
  descendants: readonly Worktree[]
}

export function DeleteWorktreeLineageNotice({
  descendants
}: DeleteWorktreeLineageNoticeProps): JSX.Element | null {
  const childWorkspaceCount = descendants.length
  if (childWorkspaceCount === 0) {
    return null
  }

  return (
    <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Workflow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">Child workspaces won&apos;t be deleted</div>
          <div className="mt-1 text-muted-foreground">
            Deleting this workspace only removes the parent.{' '}
            {childWorkspaceCount === 1
              ? '1 child workspace will stay in Orca and on disk.'
              : `${childWorkspaceCount} child workspaces will stay in Orca and on disk.`}
          </div>
          <div className="mt-2 space-y-1 rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
            {descendants.slice(0, 4).map((child) => (
              <div key={child.id} className="min-w-0">
                <div className="truncate font-medium text-foreground">{child.displayName}</div>
                <div className="truncate text-muted-foreground">{child.path}</div>
              </div>
            ))}
            {descendants.length > 4 ? (
              <div className="text-muted-foreground">+{descendants.length - 4} more</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
