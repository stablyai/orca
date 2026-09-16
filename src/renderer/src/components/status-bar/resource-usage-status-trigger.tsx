import React from 'react'
import { AlertTriangle, MemoryStick, Terminal } from 'lucide-react'
import { PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function renderResourceUsageStatusTrigger({
  daemonUnreachable,
  resourceManagerAriaLabel,
  spaceScanReady,
  iconOnly,
  commitToneClass,
  memBadgeLabel,
  triggerSessionCount,
  orphanCount,
  resourceManagerTooltipLines
}: {
  daemonUnreachable: boolean
  resourceManagerAriaLabel: string
  spaceScanReady: boolean
  iconOnly: boolean
  commitToneClass: string | null
  memBadgeLabel: string
  triggerSessionCount: number
  orphanCount: number
  resourceManagerTooltipLines: { id: string; text: string; emphasized: boolean }[]
}): React.JSX.Element {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <button
            type="button"
            {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
            className="relative inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
            aria-label={
              daemonUnreachable
                ? translate(
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
            <MemoryStick className="size-3 text-muted-foreground" />
            {!iconOnly && (
              <>
                {/* Tint only: the number stays the resident sum it has always been,
                    and the tooltip names the commit figure that raised the tone. */}
                <span
                  className={cn(
                    'text-[11px] font-medium tabular-nums',
                    commitToneClass ?? 'text-muted-foreground'
                  )}
                >
                  {memBadgeLabel}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <Terminal className="size-3 text-muted-foreground" />
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {triggerSessionCount}
                  {orphanCount > 0 && (
                    <span className="text-yellow-500 ml-0.5">({orphanCount})</span>
                  )}
                </span>
              </>
            )}
            {iconOnly && triggerSessionCount > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {triggerSessionCount}
              </span>
            )}
            {daemonUnreachable && (
              <AlertTriangle
                className="size-3 text-yellow-500"
                aria-label={translate(
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
