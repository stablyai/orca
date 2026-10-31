import React, { useMemo, useState } from 'react'
import { Loader2, Play, ScrollText, Settings2, Square, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { startWorkspaceServer, stopWorkspaceServer } from '@/lib/start-workspace-server'
import {
  matchingWorkspaceServerPort,
  useWorkspaceServerLaunches,
  workspaceServerLogPort,
  type WorkspaceServerLaunch
} from '@/lib/workspace-server-launches'
import { useWorkspaceServerProcesses } from '@/lib/workspace-server-processes'
import { WorkspaceServerLogViews } from './workspace-server-log-views'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'

function WorkspaceServerLaunchListForScope({
  worktreeId,
  runtimeTarget,
  executionHostId,
  scan,
  onConfigure,
  onRefresh,
  onStopPort
}: {
  worktreeId: string
  runtimeTarget: RuntimeClientTarget
  executionHostId: string
  scan: WorkspacePortScanResult | null
  onConfigure: (port: WorkspacePort & { kind: 'workspace' }, running?: boolean) => void
  onRefresh: () => Promise<unknown>
  onStopPort: (port: WorkspacePort) => Promise<void>
}): React.JSX.Element | null {
  const records = useWorkspaceServerLaunches()
  const stream = useWorkspaceServerProcesses(runtimeTarget, worktreeId, executionHostId)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const entries = useMemo(
    () =>
      records.filter(
        (entry) =>
          entry.worktreeId === worktreeId &&
          entry.executionHostId === executionHostId &&
          entry.runtimeTarget.kind === runtimeTarget.kind &&
          (entry.runtimeTarget.kind !== 'environment' ||
            (runtimeTarget.kind === 'environment' &&
              entry.runtimeTarget.environmentId === runtimeTarget.environmentId))
      ),
    [records, worktreeId, executionHostId, runtimeTarget]
  )
  const act = async (entry: WorkspaceServerLaunch, stop: boolean) => {
    setBusy((current) => new Set(current).add(entry.id))
    try {
      const run = stream.runs.find((item) => item.port === entry.port)
      if (stop && run?.active) {
        await stopWorkspaceServer(entry, run.id)
      } else if (stop) {
        const port = matchingWorkspaceServerPort(entry, scan)
        if (port) {
          await onStopPort(port)
        }
      } else {
        setSelected(entry.id)
        await startWorkspaceServer(entry)
      }
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(entry.id)
        return next
      })
    }
  }
  if (!entries.length) {
    return null
  }
  return (
    <>
      <section
        className="px-3 pt-2"
        aria-label={translate('auto.components.right.sidebar.index.savedServers', 'Saved Servers')}
      >
        <div className="mb-1 border-b border-border/40 py-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.right.sidebar.index.savedServers', 'Saved Servers')}
        </div>
        {stream.error && (
          <p role="status" className="py-2 text-xs text-destructive">
            {stream.error}
          </p>
        )}
        {entries.map((entry) => {
          const run = stream.runs.find((item) => item.port === entry.port)
          const detected = matchingWorkspaceServerPort(entry, scan)
          const managedActive = run?.active
          const externalActive = !managedActive && Boolean(detected)
          const running = Boolean(managedActive || externalActive)
          const pending =
            busy.has(entry.id) || run?.status === 'starting' || run?.status === 'stopping'
          const conflict = !running && scan?.ports.some((port) => port.port === entry.port)
          const failed = run?.status === 'error' && !externalActive
          const status = failed
            ? run?.active
              ? translate('auto.components.right.sidebar.index.serverProcessError', 'Server Error')
              : translate('auto.components.right.sidebar.index.serverFailed', 'Exited with Error')
            : run?.status === 'stopping'
              ? translate('auto.components.right.sidebar.index.serverStopping', 'Stopping…')
              : managedActive
                ? translate('auto.components.right.sidebar.index.serverRunning', 'Running')
                : externalActive
                  ? translate(
                      'auto.components.right.sidebar.index.serverRunningElsewhere',
                      'Started Elsewhere'
                    )
                  : conflict
                    ? translate(
                        'auto.components.right.sidebar.index.serverPortBusy',
                        'Port already in use'
                      )
                    : translate('auto.components.right.sidebar.index.serverStopped', 'Stopped')
          const errorCount = run?.errorCount ?? 0
          return (
            <div
              key={entry.id}
              className="group flex items-center gap-1 rounded px-1 py-2 hover:bg-accent/50"
              aria-label={entry.name}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setSelected(entry.id)}
              >
                <div className="truncate text-xs font-medium text-foreground">{entry.name}</div>
                <div className="text-2xs text-muted-foreground">
                  :{entry.port} · {status}
                  {failed && run?.exitCode !== null ? ` (${run?.exitCode})` : ''}
                </div>
                {(failed || errorCount > 0) && (
                  <Badge variant="destructive" className="mt-1 gap-1">
                    <AlertCircle size={10} />
                    {translate(
                      'auto.components.right.sidebar.index.serverLogErrors',
                      'Errors: {{count}}',
                      { count: errorCount }
                    )}
                  </Badge>
                )}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={
                        pending ||
                        (!running &&
                          (!stream.connected ||
                            !scan ||
                            Boolean(scan.unavailableReason) ||
                            conflict)) ||
                        (Boolean(managedActive) && !stream.connected)
                      }
                      aria-label={
                        running
                          ? translate(
                              'auto.components.right.sidebar.index.stopServer',
                              'Stop Server'
                            )
                          : translate(
                              'auto.components.right.sidebar.index.startServer',
                              'Start Server'
                            )
                      }
                      onClick={() => void act(entry, running)}
                    >
                      {pending ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : running ? (
                        <Square size={13} />
                      ) : (
                        <Play size={13} />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {running
                    ? translate('auto.components.right.sidebar.index.stopServer', 'Stop Server')
                    : translate('auto.components.right.sidebar.index.startServer', 'Start Server')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'auto.components.right.sidebar.index.openServerLogs',
                      'Open Logs'
                    )}
                    onClick={() => setSelected(entry.id)}
                  >
                    <ScrollText size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate('auto.components.right.sidebar.index.openServerLogs', 'Open Logs')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'auto.components.right.sidebar.index.configureServerCommand',
                      'Configure Startup Command'
                    )}
                    onClick={() =>
                      onConfigure(detected ?? workspaceServerLogPort(entry), Boolean(managedActive))
                    }
                  >
                    <Settings2 size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.right.sidebar.index.configureServerCommand',
                    'Configure Startup Command'
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </section>
      {selected && (
        <WorkspaceServerLogViews
          entries={entries}
          runs={stream.runs}
          selected={selected}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

export function WorkspaceServerLaunchList(
  props: React.ComponentProps<typeof WorkspaceServerLaunchListForScope>
): React.JSX.Element {
  const { runtimeTarget, executionHostId, worktreeId } = props
  const scope = JSON.stringify([
    runtimeTarget.kind,
    runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
    executionHostId,
    worktreeId
  ])
  return <WorkspaceServerLaunchListForScope key={scope} {...props} />
}
