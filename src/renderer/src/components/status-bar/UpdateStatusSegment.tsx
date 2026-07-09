import React from 'react'
import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
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
        label: translate(
          'auto.components.status.bar.UpdateStatusSegment.41f54a9bb0',
          'Update queued'
        ),
        tooltip: translate(
          'auto.components.status.bar.UpdateStatusSegment.f3d85767f4',
          '{{value0}} still working; Orca v{{value1}} will update when idle',
          { value0: agentLabel, value1: version }
        ),
        ariaLabel: translate(
          'auto.components.status.bar.UpdateStatusSegment.e57b707ccb',
          '{{value0}} still working. Update queued until agents are idle. Click to expand.',
          { value0: agentLabel }
        )
      }
    }
    if (idleInstall.phase === 'grace') {
      return {
        icon: 'spinner',
        label: translate(
          'auto.components.status.bar.UpdateStatusSegment.d87e814a1f',
          'Updating soon'
        ),
        tooltip: translate(
          'auto.components.status.bar.UpdateStatusSegment.90cc055edc',
          'Agents idle; Orca v{{value0}} will update shortly',
          { value0: version }
        ),
        ariaLabel: translate(
          'auto.components.status.bar.UpdateStatusSegment.ef64f04a82',
          'Agents idle. Update will install shortly. Click to expand.'
        )
      }
    }
    return {
      icon: 'spinner',
      label: translate(
        'auto.components.status.bar.UpdateStatusSegment.41f54a9bb0',
        'Update queued'
      ),
      tooltip: translate(
        'auto.components.status.bar.UpdateStatusSegment.0aa2610a61',
        'Orca v{{value0}} downloading; install will wait for idle agents',
        { value0: version }
      ),
      ariaLabel: translate(
        'auto.components.status.bar.UpdateStatusSegment.dfa7662691',
        'Update downloading. Install queued until agents are idle. Click to expand.'
      )
    }
  }

  if (status.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(status.percent)))
    return {
      icon: 'download',
      label: `${pct}%`,
      tooltip: translate(
        'auto.components.status.bar.UpdateStatusSegment.248ee5d8ef',
        'Orca v{{value0}} downloading… {{value1}}%',
        { value0: status.version, value1: pct }
      ),
      ariaLabel: translate(
        'auto.components.status.bar.UpdateStatusSegment.fd1d3b3a1d',
        'Update downloading, {{value0}} percent. Click to expand.',
        { value0: pct }
      )
    }
  }
  if (status.state === 'downloaded') {
    return {
      icon: 'check',
      label: translate('auto.components.status.bar.UpdateStatusSegment.57a29c3b0e', 'Update ready'),
      tooltip: translate(
        'auto.components.status.bar.UpdateStatusSegment.9d13213a56',
        'Orca v{{value0}} ready to install',
        { value0: status.version }
      ),
      ariaLabel: translate(
        'auto.components.status.bar.UpdateStatusSegment.962404f68e',
        'Update ready to install. Click to expand.'
      )
    }
  }
  if (status.state === 'error') {
    return {
      icon: 'alert',
      label: translate(
        'auto.components.status.bar.UpdateStatusSegment.8533c12c3c',
        'Update failed'
      ),
      tooltip: translate(
        'auto.components.status.bar.UpdateStatusSegment.2201df6987',
        'Update failed — click to see details'
      ),
      ariaLabel: translate(
        'auto.components.status.bar.UpdateStatusSegment.5cd13105a3',
        'Update failed. Click to expand.'
      )
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
