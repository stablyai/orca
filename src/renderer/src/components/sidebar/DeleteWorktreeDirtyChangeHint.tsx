import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function DeleteWorktreeDirtyChangeHint({
  changeCount
}: {
  changeCount: number | undefined
}): JSX.Element | null {
  if (changeCount === undefined) {
    return null
  }

  const label =
    changeCount > 0
      ? `${changeCount} uncommitted or untracked ${changeCount === 1 ? 'change' : 'changes'}`
      : 'Uncommitted or untracked changes'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mt-1 flex w-fit max-w-full items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-medium">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Deleting this workspace permanently removes these changes from disk.
      </TooltipContent>
    </Tooltip>
  )
}
