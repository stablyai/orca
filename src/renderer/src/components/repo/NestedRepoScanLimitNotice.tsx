import { CircleHelp } from 'lucide-react'
import { useState } from 'react'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 1000 && timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000} seconds`
  }
  return `${timeoutMs} ms`
}

export function nestedRepoScanLimitText(scan: NestedRepoScanResult): string {
  const automaticStops = [`${scan.maxDepth} folder levels`, `${scan.maxRepos} repositories`]
  if (scan.timeoutMs !== null) {
    automaticStops.push(formatTimeout(scan.timeoutMs))
  }
  return `Scan stops after ${automaticStops.join(' or ')}. You can stop scanning early and import repositories found so far.`
}

export function NestedRepoScanLimitNotice({ scan }: { scan: NestedRepoScanResult }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsText = nestedRepoScanLimitText(scan)

  return (
    <div
      className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      onPointerEnter={() => setDetailsOpen(true)}
      onPointerLeave={() => setDetailsOpen(false)}
      onFocusCapture={() => setDetailsOpen(true)}
      onBlurCapture={() => setDetailsOpen(false)}
    >
      <span>{scan.stopped ? 'Scan stopped early.' : 'Showing partial scan results.'}</span>
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Nested repository scan limits"
            aria-expanded={detailsOpen}
            title={detailsText}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={(event) => {
              event.stopPropagation()
              setDetailsOpen(true)
            }}
          >
            <CircleHelp className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          sideOffset={4}
          className="max-w-[260px] px-3 py-2 text-xs leading-5 text-pretty"
          // Why: this popover opens on hover, so default focus-on-open would
          // yank focus off the dialog every time the pointer grazes the icon.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {detailsText}
        </PopoverContent>
      </Popover>
    </div>
  )
}
