import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  killWorkspacePortOnExecutionHost,
  scanWorkspacePortsOnExecutionHost,
  type HostScopedPortHost
} from '@/lib/workspace-port-scan-client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspacePort, WorkspacePortHostScanResult } from '../../../../shared/workspace-ports'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { LocalPortSection } from './local-port-section'
import { LocalPortDetailsDialog } from './local-port-details-dialog'

const HOST_SCOPED_PORT_SCAN_INTERVAL_MS = 30_000

function hostScopedPortHostKey(host: HostScopedPortHost): string {
  return JSON.stringify([host.route.target, host.executionHostId, host.worktreeId])
}

/**
 * Ports on an SSH host, scanned and stopped only through the endpoint that owns it. No browser
 * open: a URL opened here would reach this client's machine, not the SSH host.
 */
export function HostScopedPortsPanel({
  host,
  isVisible
}: {
  /** Must keep its identity while the host is unchanged; each new identity starts a scan. */
  host: HostScopedPortHost
  isVisible: boolean
}): React.JSX.Element {
  const hostKey = hostScopedPortHostKey(host)
  // Why keyed: a scan that lands after the workspace switched hosts must never show as this host's.
  const [scanned, setScanned] = useState<{ key: string; scan: WorkspacePortHostScanResult } | null>(
    null
  )
  const [refreshing, setRefreshing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [detailsPort, setDetailsPort] = useState<WorkspacePort | null>(null)
  const scan = scanned?.key === hostKey ? scanned.scan : null

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const next = await scanWorkspacePortsOnExecutionHost(host)
      setScanned({ key: hostKey, scan: next })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setScanned({
        key: hostKey,
        scan: {
          executionHostId: host.executionHostId,
          platform: 'unknown',
          scannedAt: Date.now(),
          ports: [],
          unavailableReason: message || 'Workspace port scan failed.'
        }
      })
    } finally {
      setRefreshing(false)
    }
  }, [host, hostKey])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: HOST_SCOPED_PORT_SCAN_INTERVAL_MS
    })
  }, [isVisible, refresh])

  const handleStopPort = useCallback(
    async (port: WorkspacePort) => {
      if (!scan || !port.pid) {
        return
      }
      const result = await killWorkspacePortOnExecutionHost(host, {
        scannedHostId: scan.executionHostId,
        pid: port.pid,
        port: port.port
      }).catch((error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error)
      }))
      if (!result.ok) {
        toast.error(result.reason)
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.PortsPanel.97b562d21d',
          'Stopped process on :{{value0}}',
          { value0: port.port }
        )
      )
      void refresh()
    },
    [host, refresh, scan]
  )

  const ports = useMemo(() => scan?.ports ?? [], [scan])
  const parsedHost = parseExecutionHostId(host.executionHostId)
  const hostLabel = parsedHost?.kind === 'ssh' ? parsedHost.targetId : host.executionHostId

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.right.sidebar.PortsPanel.6bc058dbe1', 'Ports')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label={translate(
                'auto.components.right.sidebar.PortsPanel.7822e3edc6',
                'Refresh Ports'
              )}
            >
              <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.right.sidebar.PortsPanel.7822e3edc6', 'Refresh Ports')}
          </TooltipContent>
        </Tooltip>
      </div>

      {scan?.unavailableReason ? (
        <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
          {translate(
            'auto.components.right.sidebar.PortsPanel.f59c783b7a',
            'Port scan unavailable on {{value0}}: {{value1}}',
            { value0: hostLabel, value1: scan.unavailableReason }
          )}
        </div>
      ) : scan && ports.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 px-4 text-center text-muted-foreground">
          <Server size={32} className="mb-3 opacity-50" />
          <p className="text-sm">
            {translate('auto.components.right.sidebar.PortsPanel.38b16cfbef', 'No ports detected')}
          </p>
        </div>
      ) : (
        <LocalPortSection
          id="detected"
          title={translate('auto.components.right.sidebar.PortsPanel.36b1b2984a', 'Detected')}
          ports={ports}
          emptyText={
            scan
              ? undefined
              : translate('auto.components.right.sidebar.PortsPanel.0d63d94db3', 'Scanning...')
          }
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          onStopPort={(port) => void handleStopPort(port)}
          onShowDetails={setDetailsPort}
        />
      )}

      <LocalPortDetailsDialog port={detailsPort} onClose={() => setDetailsPort(null)} />
    </div>
  )
}
