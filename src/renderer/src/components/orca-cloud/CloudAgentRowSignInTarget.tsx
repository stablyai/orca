// The status (dot and text) of a cloud agent row that needs sign-in: clicking it opens
// Settings → Agent accounts, where the fix lives. The rest of the row still opens the pane.
import React, { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STATE_INDICATOR_TOOLTIP_DELAY_MS } from '@/components/StateIndicatorTooltip'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'

/** What the status shows: its label, the agent's catalog name, and the tooltip naming the fix. */
export type CloudAgentRowStatusText = { label: string; agentName: string; tooltip: string | null }

/** The sidebar row's "Set up once": the focused Orca Cloud sign-in sheet (JA-04). */
export function openCloudAgentAccountsSettings(): void {
  openOrcaCloudAgentAccounts()
}

/**
 * A focusable status button: the app tooltip names the fix on hover and on keyboard focus. It
 * opens below, from the row's start, so the workspace name above the row stays visible.
 */
export function CloudAgentRowSignInTarget({
  tooltip,
  ariaLabel,
  className,
  children
}: {
  /** Null shows no tooltip. */
  tooltip: string | null
  /** For the dot, whose button has no text of its own. */
  ariaLabel?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    openCloudAgentAccountsSettings()
  }, [])
  const button = (
    <button
      type="button"
      className={cn(
        'inline-flex min-w-0 shrink-0 cursor-pointer items-center rounded-sm text-left',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      aria-label={ariaLabel}
      data-cloud-sign-in-status=""
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  )
  if (tooltip === null) {
    return button
  }
  return (
    <Tooltip delayDuration={STATE_INDICATOR_TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** The status dot: the attention dot, opening Agent accounts. Its tooltip is the button's. */
export function CloudAgentRowSignInDot({
  status,
  size
}: {
  status: CloudAgentRowStatusText
  size: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <CloudAgentRowSignInTarget
      tooltip={status.tooltip}
      ariaLabel={`${status.label} - ${status.agentName}`}
    >
      <AgentStateDot state="permission" size={size} title={null} />
    </CloudAgentRowSignInTarget>
  )
}

/**
 * The full row's label slot: "Needs sign-in - Claude", the status linking to Agent accounts and the
 * agent's catalog name after it; the rest of the slot opens the pane.
 */
export function CloudAgentRowSignInLabel({
  status,
  emphasis
}: {
  status: CloudAgentRowStatusText
  /** Matches the full row's label: bold when unvisited, brighter on the selected-row fill. */
  emphasis: 'unvisited' | 'highlighted' | 'muted'
}): React.JSX.Element {
  return (
    <span className="block min-w-0 flex-1 truncate text-[11px] leading-snug">
      <CloudAgentRowSignInTarget
        tooltip={status.tooltip}
        className={cn(
          'inline hover:underline',
          emphasis === 'unvisited'
            ? 'font-semibold text-foreground'
            : emphasis === 'highlighted'
              ? 'font-normal text-foreground/90'
              : 'font-normal text-muted-foreground'
        )}
      >
        {status.label}
      </CloudAgentRowSignInTarget>
      <span
        className={emphasis === 'highlighted' ? 'text-foreground/70' : 'text-muted-foreground/65'}
      >
        {' - '}
        {status.agentName}
      </span>
    </span>
  )
}
