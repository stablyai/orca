import { CircleHelp } from 'lucide-react'
import { useState } from 'react'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

function formatTimeout(timeoutMs: number, t: Translate = translate): string {
  if (timeoutMs >= 1000 && timeoutMs % 1000 === 0) {
    const count = timeoutMs / 1000
    return t('auto.components.repo.NestedRepoScanLimitNotice.seconds', '{{count}} seconds', {
      count,
      defaultValue_one: '{{count}} second'
    })
  }
  return t('auto.components.repo.NestedRepoScanLimitNotice.milliseconds', '{{count}} ms', {
    count: timeoutMs
  })
}

function folderLevelsLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.repo.NestedRepoScanLimitNotice.folderLevels',
    '{{count}} folder levels',
    { count, defaultValue_one: '{{count}} folder level' }
  )
}

function repositoriesLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.repo.NestedRepoScanLimitNotice.repositories',
    '{{count}} repositories',
    { count, defaultValue_one: '{{count}} repository' }
  )
}

export function nestedRepoScanLimitText(
  scan: NestedRepoScanResult,
  t: Translate = translate
): string {
  const depth = folderLevelsLabel(scan.maxDepth, t)
  const repos = repositoriesLabel(scan.maxRepos, t)
  return scan.timeoutMs === null
    ? t(
        'auto.components.repo.NestedRepoScanLimitNotice.limitText',
        'Scan stops after {{depth}} or {{repos}}. You can stop scanning early and import repositories found so far.',
        { depth, repos }
      )
    : t(
        'auto.components.repo.NestedRepoScanLimitNotice.limitTextWithTimeout',
        'Scan stops after {{depth}}, {{repos}}, or {{timeout}}. You can stop scanning early and import repositories found so far.',
        { depth, repos, timeout: formatTimeout(scan.timeoutMs, t) }
      )
}

export function NestedRepoScanLimitNotice({ scan }: { scan: NestedRepoScanResult }) {
  const t = useTranslate()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsText = nestedRepoScanLimitText(scan, t)

  return (
    <div
      className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      onPointerEnter={() => setDetailsOpen(true)}
      onPointerLeave={() => setDetailsOpen(false)}
      onPointerDown={(event) => {
        if (event.button === 2) {
          event.preventDefault()
        }
      }}
      onContextMenu={() => setDetailsOpen(false)}
      onFocusCapture={() => setDetailsOpen(true)}
      onBlurCapture={() => setDetailsOpen(false)}
    >
      <span>
        {scan.stopped
          ? t('auto.components.repo.NestedRepoScanLimitNotice.03e9beab7b', 'Scan stopped early.')
          : t(
              'auto.components.repo.NestedRepoScanLimitNotice.574eb5408b',
              'Showing partial scan results.'
            )}
      </span>
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t(
              'auto.components.repo.NestedRepoScanLimitNotice.642a43c139',
              'Nested repository scan limits'
            )}
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
          onContextMenu={(event) => event.stopPropagation()}
          // Hover-open must not move focus from the dialog when the pointer grazes this icon.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {detailsText}
        </PopoverContent>
      </Popover>
    </div>
  )
}
