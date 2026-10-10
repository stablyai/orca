import React from 'react'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { hostScopeDescriptor } from './automation-host-scope-descriptors'
import {
  authorityHealthDescriptor,
  executionHealthDescriptor,
  type AutomationHostStatusDescriptor,
  type AutomationHostStatusTone
} from './automation-host-status-descriptors'

/**
 * Host identity and status chips. The two health axes render as two chips and
 * never merge: a host can be freshly loaded and disconnected at the same time.
 */

type BadgeStyle = { variant: React.ComponentProps<typeof Badge>['variant']; className?: string }

// `Badge` has no muted variant and this design does not add one — quiet reads as outline + muted text.
const TONE_STYLE: Record<AutomationHostStatusTone, BadgeStyle> = {
  neutral: { variant: 'outline' },
  quiet: { variant: 'outline', className: 'text-muted-foreground' },
  attention: { variant: 'secondary' },
  error: { variant: 'destructive' }
}

type AutomationHostLabelProps = {
  entry: AutomationHostCatalogEntry
  /** Host accent color; falls back to a neutral token so no new color is invented. */
  color?: string | null
  showAuthority?: boolean
  className?: string
}

export function AutomationHostLabel({
  entry,
  color,
  showAuthority = false,
  className
}: AutomationHostLabelProps): React.JSX.Element {
  const accessibleName = showAuthority ? `${entry.authorityLabel} · ${entry.label}` : entry.label

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Truncation lives on the inner label, so the full name stays in the accessible name. */}
        <span
          className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)}
          aria-label={accessibleName}
          data-host-stable-key={entry.stableKey}
        >
          <RepoBadgeLabel
            name={entry.label}
            color={color ?? 'var(--muted-foreground)'}
            className="max-w-full"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {accessibleName}
      </TooltipContent>
    </Tooltip>
  )
}

type StatusBadgeProps = {
  descriptor: AutomationHostStatusDescriptor
  axis: 'authority' | 'execution' | 'query'
}

function StatusBadge({ descriptor, axis }: StatusBadgeProps): React.JSX.Element {
  const style = TONE_STYLE[descriptor.tone]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={style.variant}
          className={cn('max-w-[12rem] text-[11px]', style.className)}
          data-status-axis={axis}
          data-status-id={descriptor.id}
          aria-label={`${descriptor.label}. ${descriptor.description}`}
        >
          <span className="truncate">{descriptor.label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {descriptor.description}
      </TooltipContent>
    </Tooltip>
  )
}

type AutomationHostStatusBadgesProps = {
  entry: AutomationHostCatalogEntry
  /** Render the resting states too; off by default so healthy rows stay quiet. */
  showHealthy?: boolean
  className?: string
}

export function AutomationHostStatusBadges({
  entry,
  showHealthy = false,
  className
}: AutomationHostStatusBadgesProps): React.JSX.Element | null {
  const authority = authorityHealthDescriptor(entry.authorityHealth)
  const execution = executionHealthDescriptor(entry.executionHealth)
  const query = hostScopeDescriptor(entry)
  const showAuthority = showHealthy || !authority.isDefault
  const showExecution = showHealthy || !execution.isDefault

  if (!showAuthority && !showExecution && !query) {
    return null
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {showAuthority ? <StatusBadge descriptor={authority} axis="authority" /> : null}
      {showExecution ? <StatusBadge descriptor={execution} axis="execution" /> : null}
      {query ? <StatusBadge descriptor={query} axis="query" /> : null}
    </span>
  )
}
