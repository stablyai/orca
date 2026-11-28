import React from 'react'
import { AlertTriangle, MemoryStick, Terminal } from 'lucide-react'
import { PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../../composition/status-bar-context-menu-policy'

export function focusResourceManagerTrigger(): void {
  document.querySelector<HTMLElement>('[data-resource-manager-trigger]')?.focus()
}

export function renderResourceUsageStatusTrigger(
  {
    daemonUnreachable,
    resourceManagerAriaLabel,
    spaceScanReady,
    commitToneClass,
    triggerSessionCount,
    orphanCount,
    resourceManagerTooltipLines,
    appMemoryLabel
  }: {
    daemonUnreachable: boolean
    resourceManagerAriaLabel: string
    spaceScanReady: boolean
    commitToneClass: string | null
    triggerSessionCount: number | null
    orphanCount: number
    resourceManagerTooltipLines: { id: string; text: string; emphasized: boolean }[]
    appMemoryLabel: string | null
  },
  t: Translate = translate
): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-resource-manager-trigger=""
            {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
            className="relative inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
            aria-label={
              daemonUnreachable
                ? t(
                    'auto.components.status.bar.ResourceUsageStatusSegment.59f178fe11',
                    '{{value0}}, daemon unreachable',
                    { value0: resourceManagerAriaLabel }
                  )
                : resourceManagerAriaLabel
            }
          >
            {spaceScanReady ? (
              <span
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
                aria-hidden="true"
              />
            ) : null}
            <MemoryStick className={cn('size-3', commitToneClass ?? 'text-muted-foreground')} />
            {appMemoryLabel !== null && (
              // Why: min width keeps neighbours still as the value moves between MB and GB.
              <span className="min-w-[6ch] text-[11px] tabular-nums text-foreground">
                {appMemoryLabel}
              </span>
            )}
            <Terminal
              className={cn('size-3 text-muted-foreground', appMemoryLabel !== null && 'ml-2.5')}
            />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {triggerSessionCount}
              {orphanCount > 0 && (
                <span className="ml-0.5 text-status-warning-text">({orphanCount})</span>
              )}
            </span>
            {daemonUnreachable && (
              <AlertTriangle
                className="size-3 text-yellow-500"
                aria-label={t(
                  'auto.components.status.bar.ResourceUsageStatusSegment.ca95d077db',
                  'Daemon unreachable'
                )}
              />
            )}
          </button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <div className="space-y-0.5">
          {resourceManagerTooltipLines.map((line) => (
            <div key={line.id} className={line.emphasized ? 'text-primary' : ''}>
              {line.text}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
