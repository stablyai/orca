import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { OpenFile } from '@/store/slices/editor'
import { getCombinedDiffCommitMessageBody } from './combined-diff-commit-message'

export function CombinedDiffCommitHeader({
  commitCompare
}: {
  commitCompare: NonNullable<OpenFile['commitCompare']>
}): React.JSX.Element {
  const commitBody = getCombinedDiffCommitMessageBody(commitCompare.message, commitCompare.subject)

  return (
    <div className="border-b border-border bg-background px-4 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {commitCompare.subject && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="truncate text-sm font-semibold text-foreground"
                  title={commitCompare.subject}
                >
                  {commitCompare.subject}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6} className="max-w-96">
                {commitCompare.subject}
              </TooltipContent>
            </Tooltip>
          )}
          {commitBody && (
            <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground scrollbar-sleek">
              {commitBody}
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] leading-5 text-muted-foreground">
          {commitCompare.compareRef}
        </span>
      </div>
    </div>
  )
}
