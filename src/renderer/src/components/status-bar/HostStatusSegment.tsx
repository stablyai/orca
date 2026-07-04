import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Gauge, Cpu, MemoryStick, Clock, Server } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import type { HostResourceMetrics } from '../../../../shared/host-resource-metrics-types'
import type { HostSession } from '../../../../shared/host-session-types'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  agentDotClass,
  clampPercent,
  formatGib,
  formatLoad,
  formatUptime
} from './host-status-format'
import { translate } from '@/i18n/i18n'

type HostStatusSegmentProps = {
  compact?: boolean
  iconOnly: boolean
}

// Why: metrics are cheap (os.* on the remote), so poll them continuously for the
// glanceable summary; session discovery walks tmux/ps/git, so only run it while
// the popover is open to avoid steady load on the host.
const METRICS_POLL_MS = 12_000
const SESSIONS_POLL_MS = 5_000

export function HostStatusSegment({ iconOnly }: HostStatusSegmentProps): React.JSX.Element | null {
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const [open, setOpen] = useState(false)
  const [metrics, setMetrics] = useState<HostResourceMetrics | null>(null)
  const [sessions, setSessions] = useState<HostSession[]>([])
  const [tmuxAvailable, setTmuxAvailable] = useState(true)

  // Why: the segment targets the active execution host — the first user-managed
  // SSH target that is connected. Runtime-owned targets are Orca's own ephemeral
  // VMs and are hidden from host-facing surfaces.
  const targetId = useMemo(() => {
    for (const [id, state] of sshConnectionStates) {
      if (state.status === 'connected' && !isRuntimeOwnedSshTargetId(id)) {
        return id
      }
    }
    return null
  }, [sshConnectionStates])

  const label = targetId ? (sshTargetLabels.get(targetId) ?? targetId) : ''

  const refreshMetrics = useCallback(async (id: string) => {
    const result = await window.api.ssh.getHostMetrics({ targetId: id })
    setMetrics(result.metrics)
  }, [])

  const refreshSessions = useCallback(async (id: string) => {
    const result = await window.api.ssh.discoverHostSessions({ targetId: id })
    setSessions(result.sessions)
    setTmuxAvailable(result.tmuxAvailable)
  }, [])

  useEffect(() => {
    if (!targetId) {
      setMetrics(null)
      return
    }
    void refreshMetrics(targetId).catch(() => setMetrics(null))
    const timer = setInterval(() => void refreshMetrics(targetId).catch(() => {}), METRICS_POLL_MS)
    return () => clearInterval(timer)
  }, [targetId, refreshMetrics])

  useEffect(() => {
    if (!targetId || !open) {
      return
    }
    void refreshSessions(targetId).catch(() => setSessions([]))
    const timer = setInterval(
      () => void refreshSessions(targetId).catch(() => {}),
      SESSIONS_POLL_MS
    )
    return () => clearInterval(timer)
  }, [targetId, open, refreshSessions])

  if (!targetId) {
    return null
  }

  const memoryPercent = metrics ? clampPercent(metrics.memoryUsagePercent) : 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={translate(
                'auto.components.status.bar.HostStatusSegment.aa85babed1',
                'Remote host metrics'
              )}
              className="inline-flex h-5 items-center gap-1 rounded border border-border bg-secondary px-1.5 text-secondary-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Gauge className="size-3 shrink-0 text-muted-foreground" />
              {!iconOnly && metrics && (
                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                  {formatLoad(metrics.loadAverage1m)} · {memoryPercent}%
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {translate(
            'auto.components.status.bar.HostStatusSegment.tooltip',
            'Host {{label}} — load {{load}}, memory {{percent}}%',
            {
              label,
              load: metrics ? formatLoad(metrics.loadAverage1m) : '—',
              percent: memoryPercent
            }
          )}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SelectedTextCopyMenu>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Server className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{label}</span>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {metrics
                ? translate(
                    'auto.components.status.bar.HostStatusSegment.164c53f8d4',
                    '{{value0}} cores',
                    { value0: metrics.cpuCoreCount }
                  )
                : ''}
            </span>
          </div>

          {metrics ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5 text-[11px]">
              <MetricRow
                icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />}
                label={translate(
                  'auto.components.status.bar.HostStatusSegment.518f1762a3',
                  'Load avg'
                )}
                value={`${formatLoad(metrics.loadAverage1m)} · ${formatLoad(
                  metrics.loadAverage5m
                )} · ${formatLoad(metrics.loadAverage15m)}`}
              />
              <MetricRow
                icon={<Clock className="size-3 shrink-0 text-muted-foreground" />}
                label={translate(
                  'auto.components.status.bar.HostStatusSegment.0b550095d7',
                  'Uptime'
                )}
                value={formatUptime(metrics.uptimeSeconds)}
              />
              <div className="col-span-2 flex items-center gap-1.5">
                <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {translate('auto.components.status.bar.HostStatusSegment.ae01984a93', 'Memory')}
                </span>
                <span className="ml-auto tabular-nums text-foreground">
                  {translate(
                    'auto.components.status.bar.HostStatusSegment.memory',
                    '{{used}} / {{total}} GB · {{percent}}%',
                    {
                      used: formatGib(metrics.usedMemory),
                      total: formatGib(metrics.totalMemory),
                      percent: memoryPercent
                    }
                  )}
                </span>
              </div>
              <div className="col-span-2 h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full rounded bg-primary" style={{ width: `${memoryPercent}%` }} />
              </div>
            </div>
          ) : (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {translate(
                'auto.components.status.bar.HostStatusSegment.b54da3f1ac',
                'Loading host metrics...'
              )}
            </div>
          )}

          <section className="border-t border-border/60">
            <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
              <span>
                {translate(
                  'auto.components.status.bar.HostStatusSegment.0ff2a9cbee',
                  'Sessions on host'
                )}
              </span>
              <span className="ml-auto font-mono text-[10px]">{sessions.length}</span>
            </div>
            <div className="max-h-[16rem] overflow-y-auto scrollbar-sleek">
              {!tmuxAvailable ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.status.bar.HostStatusSegment.a08d335b74',
                    'tmux is not running on this host'
                  )}
                </div>
              ) : sessions.length > 0 ? (
                sessions.map((session) => (
                  <HostSessionRow
                    key={`${session.session}:${session.pid ?? ''}`}
                    session={session}
                  />
                ))
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.status.bar.HostStatusSegment.3b6f0532da',
                    'No sessions detected'
                  )}
                </div>
              )}
            </div>
          </section>
        </SelectedTextCopyMenu>
      </PopoverContent>
    </Popover>
  )
}

function MetricRow({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function HostSessionRow({ session }: { session: HostSession }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50">
      <span className={`size-1.5 shrink-0 rounded-full ${agentDotClass(session.agent)}`} />
      <span className="min-w-0 truncate font-medium text-foreground">{session.session}</span>
      {session.branch && (
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {session.branch}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {session.agent && (
          <span className="text-[10px] text-muted-foreground">{session.agent}</span>
        )}
        {session.attached && (
          <span className="text-[10px] uppercase tracking-wide text-emerald-500">
            {translate('auto.components.status.bar.HostStatusSegment.6641a07d35', 'attached')}
          </span>
        )}
      </span>
    </div>
  )
}
