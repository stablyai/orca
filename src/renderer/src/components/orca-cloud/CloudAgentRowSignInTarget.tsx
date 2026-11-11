// The status (dot and text) of a cloud agent row that needs sign-in: clicking it opens
// Settings → Agent accounts, where the fix lives. The rest of the row still opens the pane.
import React, { useCallback } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { AgentStateDot } from '@/components/AgentStateDot'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'

/** The composer's "Set up once" target, plus opening Settings, which the sidebar has closed. */
export function openCloudAgentAccountsSettings(): void {
  openOrcaCloudAgentAccounts()
  useAppStore.getState().openSettingsPage()
}

export function CloudAgentRowSignInTarget({
  tooltip,
  className,
  children
}: {
  /** Native title; null when the child (a state dot) draws its own tooltip. */
  tooltip: string | null
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    openCloudAgentAccountsSettings()
  }, [])
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-w-0 shrink-0 cursor-pointer items-center rounded-sm text-left',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      title={tooltip ?? undefined}
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  )
}

/** The full row's status dot: the attention dot, opening Agent accounts. */
export function CloudAgentRowSignInDot({
  tooltip,
  size
}: {
  tooltip: string
  size: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <CloudAgentRowSignInTarget tooltip={null}>
      <AgentStateDot state="permission" size={size} title={tooltip} />
    </CloudAgentRowSignInTarget>
  )
}

/** The full row's label slot: the text links to Agent accounts; the rest of the slot opens the pane. */
export function CloudAgentRowSignInLabel({
  label,
  tooltip,
  emphasis
}: {
  label: string
  tooltip: string
  /** Matches the full row's label: bold when unvisited, brighter on the selected-row fill. */
  emphasis: 'unvisited' | 'highlighted' | 'muted'
}): React.JSX.Element {
  return (
    <span className="block min-w-0 flex-1 truncate text-[11px] leading-snug">
      <CloudAgentRowSignInTarget
        tooltip={tooltip}
        className={cn(
          'inline hover:underline',
          emphasis === 'unvisited'
            ? 'font-semibold text-foreground'
            : emphasis === 'highlighted'
              ? 'font-normal text-foreground/90'
              : 'font-normal text-muted-foreground'
        )}
      >
        {label}
      </CloudAgentRowSignInTarget>
    </span>
  )
}
