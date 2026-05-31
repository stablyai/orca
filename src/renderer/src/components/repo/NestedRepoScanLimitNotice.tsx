import { CircleHelp } from 'lucide-react'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 1000 && timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000} seconds`
  }
  return `${timeoutMs} ms`
}

export function nestedRepoScanLimitText(scan: NestedRepoScanResult): string {
  return `Scan stops after ${scan.maxDepth} folder levels, ${scan.maxRepos} repositories, or ${formatTimeout(scan.timeoutMs)}.`
}

export function NestedRepoScanLimitNotice({ scan }: { scan: NestedRepoScanResult }) {
  return (
    <div className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>Showing partial results from a bounded scan.</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Nested repository scan limits"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <CircleHelp className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-[260px] text-pretty">
          {nestedRepoScanLimitText(scan)}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
