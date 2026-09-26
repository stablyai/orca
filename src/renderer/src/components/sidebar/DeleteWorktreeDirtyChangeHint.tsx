import { useState, type JSX } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type { DeleteWorktreeDirtyFile } from './delete-worktree-dirty-changes'

const MAX_LISTED_FILES = 10

export function DeleteWorktreeDirtyChangeHint({
  files
}: {
  files: readonly DeleteWorktreeDirtyFile[] | undefined
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (files === undefined) {
    return null
  }

  const changeCount = files.length
  const label =
    changeCount > 0
      ? `${changeCount} uncommitted or untracked ${changeCount === 1 ? 'change' : 'changes'}`
      : 'Uncommitted or untracked changes'
  const warning = translate(
    'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.8e2994ce28',
    'Deleting this workspace permanently removes these changes from disk.'
  )

  if (changeCount === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="mt-1 flex w-fit max-w-full items-center gap-1.5 text-destructive">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-medium">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {warning}
        </TooltipContent>
      </Tooltip>
    )
  }

  const hiddenCount = changeCount - MAX_LISTED_FILES
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="mt-1 flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-medium">{label}</span>
          {open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 min-w-0 rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
          <p className="text-muted-foreground">{warning}</p>
          <ul className="mt-1 min-w-0 space-y-0.5 font-mono">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li key={file.path} className="flex min-w-0 items-baseline gap-2">
                <span
                  className="w-3 shrink-0 font-semibold"
                  style={{ color: STATUS_COLORS[file.status] }}
                >
                  {STATUS_LABELS[file.status]}
                </span>
                <span className="min-w-0 break-all text-foreground">{file.path}</span>
              </li>
            ))}
            {hiddenCount > 0 ? (
              <li className="font-sans text-muted-foreground">
                {translate(
                  'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.4f1c9a7d2e',
                  'and {{value0}} more',
                  { value0: hiddenCount }
                )}
              </li>
            ) : null}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
