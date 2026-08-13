import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function CommittedBranchChangesPanel({
  count,
  collapsed,
  onToggle,
  onViewAll,
  children
}: {
  count: number
  collapsed: boolean
  onToggle: () => void
  onViewAll: () => void
  children: (scrollElement: HTMLDivElement | null) => React.ReactNode
}): React.JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  return (
    <div data-testid="committed-branch-changes-panel" className="relative border-t border-border">
      <div className="h-7 pl-1 pr-3">
        <div className="flex h-full items-stretch rounded-md pr-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 px-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-foreground/70"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <ChevronDown
              className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
            />
            <span>
              {translate(
                'auto.components.right.sidebar.SourceControl.d7ae61269b',
                'Committed on Branch'
              )}
            </span>
            <span className="text-[10px] font-medium tabular-nums">{count}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="my-auto h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={onViewAll}
          >
            {translate('auto.components.right.sidebar.SourceControl.48db37cca9', 'View all')}
          </Button>
        </div>
      </div>
      {!collapsed && (
        <div
          ref={setScrollElement}
          data-testid="committed-branch-changes-body"
          className="max-h-[33vh] overflow-y-auto scrollbar-sleek"
        >
          {children(scrollElement)}
        </div>
      )}
    </div>
  )
}
