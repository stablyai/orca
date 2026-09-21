import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { sourceCountLabel } from './skill-display-labels'
import { SKILLS_SUBTITLE_ACTION_CLASS } from './skills-subtitle-action'
import type { SkillSourceInventoryEntry, SkillSourceStatus } from './skill-source-inventory'

function statusLabel(status: SkillSourceStatus): string | null {
  switch (status) {
    case 'scanned':
      return null
    case 'missing':
      return translate('auto.components.skills.sourceStatus.missing', 'Folder not found')
    case 'remote-repo':
      return translate(
        'auto.components.skills.sourceStatus.remoteRepo',
        'Remote repo — not scanned'
      )
    case 'unavailable':
      return translate('auto.components.skills.sourceStatus.unavailable', 'Not scanned')
  }
}

export function SkillsSourcesPopover({
  entries,
  scannedCount
}: {
  entries: readonly SkillSourceInventoryEntry[]
  scannedCount: number
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="link" className={SKILLS_SUBTITLE_ACTION_CLASS}>
          {sourceCountLabel(scannedCount)}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.skills.sources.heading', 'Skill folders')}
        </p>
        <div className="scrollbar-sleek max-h-80 overflow-y-auto py-1">
          {entries.map((entry) => {
            const status = statusLabel(entry.status)
            return (
              <div key={entry.source.id} className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {entry.source.label}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {status ?? entry.skillCount}
                  </span>
                </div>
                <p
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={entry.source.path}
                >
                  {entry.source.path}
                </p>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
