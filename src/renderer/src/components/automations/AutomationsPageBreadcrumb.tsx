import React from 'react'
import { ChevronRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

export type AutomationsCrumb = {
  key: string
  label: string
  /** Absent on the current page. */
  onSelect?: () => void
}

/** The canonical path to the current page, the same however the user arrived. */
export function AutomationsPageBreadcrumb({
  items
}: {
  items: readonly AutomationsCrumb[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <nav
      aria-label={t(
        'auto.components.automations.AutomationsPageBreadcrumb.ariaLabel',
        'Automations breadcrumb'
      )}
      className="min-w-0 flex-1"
    >
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {items.map((item, index) => {
          const current = index === items.length - 1
          return (
            <li
              key={item.key}
              className={cn('flex min-w-0 items-center gap-1', current ? 'shrink-0' : 'shrink')}
              // Why: the current page keeps its room; ancestors shrink first when space runs out.
              style={current ? { maxWidth: '60%' } : undefined}
            >
              {index > 0 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : null}
              {current || !item.onSelect ? (
                <span
                  aria-current={current ? 'page' : undefined}
                  title={item.label}
                  className="min-w-0 max-w-[40ch] truncate px-1 font-medium"
                >
                  {item.label}
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={item.onSelect}
                      className="min-w-0 max-w-[40ch] truncate rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {item.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** List and Runs are siblings; their header switches between them. */
export function AutomationsPageTabs({
  current,
  automationCount,
  onShowAutomations,
  onShowRuns
}: {
  current: 'automations' | 'runs'
  automationCount: number | null
  onShowAutomations: () => void
  onShowRuns: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const tabClass = (active: boolean): string =>
    cn(
      '-mb-px flex h-12 items-center gap-1.5 border-b-2 px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
      active
        ? 'border-foreground font-semibold text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    )
  return (
    <nav
      aria-label={t('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
      className="flex items-center gap-1"
    >
      <button
        type="button"
        aria-current={current === 'automations' ? 'page' : undefined}
        className={tabClass(current === 'automations')}
        onClick={onShowAutomations}
      >
        {t('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
        {automationCount !== null ? (
          <span className="text-xs font-normal text-muted-foreground">{automationCount}</span>
        ) : null}
      </button>
      <button
        type="button"
        aria-current={current === 'runs' ? 'page' : undefined}
        className={tabClass(current === 'runs')}
        onClick={onShowRuns}
        data-contextual-tour-target="automations-runs"
      >
        {t('auto.components.automations.AutomationListToolbar.runs', 'Runs')}
      </button>
    </nav>
  )
}
