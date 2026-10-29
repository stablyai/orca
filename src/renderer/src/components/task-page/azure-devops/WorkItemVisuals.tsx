import React, { useState } from 'react'
import { Bug, ClipboardList, Crown, List, Trophy, type LucideIcon } from 'lucide-react'
import { isTerminalBackgroundLight } from '../../../../../shared/terminal-title-contrast'
import { cn } from '@/lib/utils'
import type { AzureDevOpsWorkItemTypeMetadata } from '../../../../../shared/azure-devops/boards-types'

// Why: ADO icon ids are a fixed catalogue; map the common ones and fall back to a list glyph.
const ICONS: Record<string, LucideIcon> = {
  icon_trophy: Trophy,
  icon_crown: Crown,
  icon_list: List,
  icon_insect: Bug,
  icon_clipboard: ClipboardList
}

export function azureDevOpsIconForType(iconId: string | null): LucideIcon {
  return (iconId && ICONS[iconId]) || List
}

export function workItemStateColor(
  state: string,
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
): string | null {
  return metadata?.states.find((s) => s.name === state)?.color ?? null
}

/** ADO's own type icon when it can be fetched; the lucide mapping otherwise (on-prem may not serve it). */
export function WorkItemTypeIcon({
  metadata,
  className
}: {
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
  className?: string
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const iconUrl = metadata?.iconUrl ?? null
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={16}
        height={16}
        className={cn('shrink-0', className)}
        onError={() => setFailedUrl(iconUrl)}
      />
    )
  }
  // Why: react/static-components rejects a component computed via a function call.
  return React.createElement(azureDevOpsIconForType(metadata?.iconId ?? null), {
    className: cn('shrink-0', className),
    'aria-hidden': 'true'
  })
}

export function WorkItemTypeBadge({
  type,
  metadata,
  showName = false,
  className
}: {
  type: string
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
  showName?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-work-item-type={type}
      className={cn('inline-flex items-center gap-1 text-xs', className)}
      style={{ color: metadata?.color ?? undefined }}
      title={type}
    >
      <WorkItemTypeIcon metadata={metadata} className="size-3.5" />
      {showName ? <span className="text-foreground">{type}</span> : null}
    </span>
  )
}

export function WorkItemStateDot({
  state,
  metadata,
  className
}: {
  state: string
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
  className?: string
}): React.JSX.Element {
  const color = workItemStateColor(state, metadata)
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span
        aria-label={state}
        className="inline-block size-2 rounded-full bg-muted-foreground"
        style={{ backgroundColor: color ?? undefined }}
      />
      <span>{state}</span>
    </span>
  )
}

export function WorkItemTagChip({
  tag,
  color
}: {
  tag: string
  color: string | null
}): React.JSX.Element {
  // Why: ADO tag colours are arbitrary; pick the text colour from the chip's own luminance
  // (the helper is theme-agnostic despite its terminal name) so both themes stay readable.
  const coloredText = color
    ? isTerminalBackgroundLight(color)
      ? 'text-black'
      : 'text-white'
    : null
  return (
    <span
      className={cn(
        'inline-flex max-w-[12rem] truncate rounded-sm px-1.5 py-px text-[11px] leading-4',
        coloredText ?? 'bg-muted text-foreground'
      )}
      style={{ backgroundColor: color ?? undefined }}
    >
      {tag}
    </span>
  )
}
