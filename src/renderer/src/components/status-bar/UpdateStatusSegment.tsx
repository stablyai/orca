import React from 'react'
import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import type { UpdateStatus } from '../../../../shared/types'

type UpdateStatusSegmentModel = {
  icon: 'alert' | 'check' | 'download' | 'spinner'
  label: string
  tooltip: string
  ariaLabel: string
}

export function getUpdateStatusSegmentModel(status: UpdateStatus): UpdateStatusSegmentModel | null {
  const idleInstall = 'idleInstall' in status ? status.idleInstall : undefined
  if (idleInstall) {
    const version = 'version' in status ? status.version : ''
    if (idleInstall.phase === 'waiting-for-idle') {
      const agentLabel = `${idleInstall.activeAgentCount} ${
        idleInstall.activeAgentCount === 1 ? 'agent' : 'agents'
      }`
      return {
        icon: 'spinner',
        label: 'Update queued',
        tooltip: `${agentLabel} still working; Orca v${version} will update when idle`,
        ariaLabel: `${agentLabel} still working. Update queued until agents are idle. Click to expand.`
      }
    }
    if (idleInstall.phase === 'grace') {
      return {
        icon: 'spinner',
        label: 'Updating soon',
        tooltip: `Agents idle; Orca v${version} will update shortly`,
        ariaLabel: 'Agents idle. Update will install shortly. Click to expand.'
      }
    }
    return {
      icon: 'spinner',
      label: 'Update queued',
      tooltip: `Orca v${version} downloading; install will wait for idle agents`,
      ariaLabel: 'Update downloading. Install queued until agents are idle. Click to expand.'
    }
  }

  if (status.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(status.percent)))
    return {
      icon: 'download',
      label: `${pct}%`,
      tooltip: `Orca v${status.version} downloading... ${pct}%`,
      ariaLabel: `Update downloading, ${pct} percent. Click to expand.`
    }
  }
  if (status.state === 'downloaded') {
    return {
      icon: 'check',
      label: 'Update ready',
      tooltip: `Orca v${status.version} ready to install`,
      ariaLabel: 'Update ready to install. Click to expand.'
    }
  }
  if (status.state === 'error') {
    return {
      icon: 'alert',
      label: 'Update failed',
      tooltip: 'Update failed - click to see details',
      ariaLabel: 'Update failed. Click to expand.'
    }
  }
  return null
}

// Why: always rendered (not gated by `statusBarItems`). When the update card
// is collapsed, this segment is the only way back to it — hiding it would
// strand the user with an orphaned download or install.
export function UpdateStatusSegment({
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const status = useAppStore((s) => s.updateStatus)
  const collapsed = useAppStore((s) => s.updateCardCollapsed)
  const setCollapsed = useAppStore((s) => s.setUpdateCardCollapsed)
  const segment = getUpdateStatusSegmentModel(status)

  if (!segment) {
    return null
  }

  const handleClick = () => {
    setCollapsed(!collapsed)
  }

  const icon =
    segment.icon === 'download' ? (
      <Download className="size-3 text-muted-foreground" />
    ) : segment.icon === 'check' ? (
      <CheckCircle2 className="size-3 text-emerald-500" />
    ) : segment.icon === 'spinner' ? (
      <Loader2 className="size-3 animate-spin text-muted-foreground" />
    ) : (
      <AlertCircle className="size-3 text-yellow-500" />
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={segment.ariaLabel}
          aria-expanded={!collapsed}
        >
          {icon}
          {!iconOnly && <span className="text-[11px] tabular-nums">{segment.label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {segment.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
