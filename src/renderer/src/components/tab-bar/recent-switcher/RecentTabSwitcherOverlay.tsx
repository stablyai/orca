import { createPortal } from 'react-dom'
import { FileText, GitCompare, GitGraph, Globe2, TerminalSquare } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { RecentTabSwitcherItem } from './recent-tab-switching'

function TabIcon({ item }: { item: RecentTabSwitcherItem }): React.JSX.Element {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (item.type === 'terminal') {
    return <TerminalSquare className={className} />
  }
  if (item.type === 'browser') {
    return <Globe2 className={className} />
  }
  if (item.contentType === 'git-graph') {
    return <GitGraph className={className} />
  }
  if (
    item.contentType === 'diff' ||
    item.contentType === 'conflict-review' ||
    item.contentType === 'check-details'
  ) {
    return <GitCompare className={className} />
  }
  return <FileText className={className} />
}

export function RecentTabSwitcherOverlay({
  items,
  selectedIndex
}: {
  items: readonly RecentTabSwitcherItem[]
  selectedIndex: number
}): React.JSX.Element {
  const t = useTranslate()
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-start justify-center pt-[12vh]">
      <div
        className="w-[min(22.5rem,calc(100vw-3rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
        role="listbox"
        aria-label={t('auto.components.tab.bar.RecentTabSwitcher.07ad4cd0b7', 'Switch tabs')}
      >
        <div className="border-b border-border px-2 py-1 text-2xs font-semibold text-muted-foreground">
          {t('auto.components.tab.bar.RecentTabSwitcher.329638ff6f', 'Switch Tab')}
        </div>
        <div className="max-h-[min(18rem,60vh)] overflow-hidden py-0.5">
          {items.map((item, index) => {
            const selected = index === selectedIndex
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={selected}
                className={cn(
                  'flex h-6 items-center gap-1.5 px-2 text-xs',
                  selected ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                <TabIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.isDirty ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
