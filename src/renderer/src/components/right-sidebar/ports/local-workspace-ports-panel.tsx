import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { useActiveWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { cn } from '@/lib/class-names'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  publishWorkspacePortScanForHost,
  refreshWorkspacePortScanAfterStop,
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-ports/workspace-port-actions'
import { resolvePortOpenInOrcaBrowser } from '@/lib/workspace-ports/workspace-port-browser-open'
import { resolveLocalhostLabelRouteForPort } from '@/lib/workspace-ports/workspace-port-localhost-label-selector'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspacePort } from '../../../../../shared/workspace/ports/workspace-ports'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  getLocalWorkspacePortSections,
  shouldShowLocalWorkspacePortSections
} from './local-workspace-port-sections'
import { useQuietPortScan } from '@/lib/workspace-ports/use-quiet-port-scan'
import { LocalPortSection } from './local-port-section'
import { LocalPortDetailsDialog } from './local-port-details-dialog'
import { SshForwardedPortsSection } from './ssh-forwarded-ports-section'
import { SshPortForwardDialog, type PortForwardDialogState } from './ssh-port-forward-dialog'
import { portForwardKey, portForwardRemoteHost } from './port-forward-remote-host'
import type { PortForwardEntry } from '../../../../../shared/remote-runtime/ssh/ssh-types'

const NO_FORWARDS: readonly PortForwardEntry[] = []

export function LocalWorkspacePortsPanel({
  isVisible,
  runtimeTarget,
  sshForwardTargetId = null
}: {
  isVisible: boolean
  /** The endpoint that owns the active workspace, even if the sidebar is focused elsewhere. */
  runtimeTarget: RuntimeClientTarget | null
  /** A managed server's SSH host, whose connection carries this client's forwards. */
  sshForwardTargetId?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const activeWorktree = useActiveWorktree()
  // Use workspace repoId directly because folder workspaces have only a synthetic ID, not a repo row.
  const activeRepoId = activeWorktree?.repoId ?? null
  const settings = useAppStore((s) => s.settings)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const scansByKey = useAppStore((s) => s.workspacePortScansByKey)
  const refreshing = useAppStore((s) => s.workspacePortScanRefreshing)
  const replaceWorkspacePortScans = useAppStore((s) => s.replaceWorkspacePortScans)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const [detailsPort, setDetailsPort] = useState<WorkspacePort | null>(null)
  const [forwardDialog, setForwardDialog] = useState<PortForwardDialogState>({ mode: 'closed' })
  const forwards = useAppStore((s) =>
    sshForwardTargetId
      ? (s.portForwardsByConnection[sshForwardTargetId] ?? NO_FORWARDS)
      : NO_FORWARDS
  )
  const canForward = useAppStore(
    (s) =>
      sshForwardTargetId !== null &&
      s.sshConnectionStates.get(sshForwardTargetId)?.status === 'connected'
  )
  const forwardedKeys = useMemo(
    () => new Set(forwards.map((entry) => portForwardKey(entry.remoteHost, entry.remotePort))),
    [forwards]
  )
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    other: true,
    external: true
  })

  const scanKey = runtimeTarget ? `${workspacePortRuntimeTargetKey(runtimeTarget)}:all` : null

  const refresh = useCallback(() => {
    if (!activeRepoId || !runtimeTarget || !scanKey) {
      return Promise.resolve()
    }
    setWorkspacePortScanRefreshing(true)
    const promise = scanWorkspacePortsForTarget(runtimeTarget)
      .then((nextScan) => {
        publishWorkspacePortScanForHost({
          scanKey,
          scan: nextScan,
          replaceWorkspacePortScans,
          getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(
          translate(
            'auto.components.right.sidebar.PortsPanel.a00f3a2840',
            'Failed to refresh ports'
          ),
          {
            description:
              message ||
              translate(
                'auto.components.right.sidebar.PortsPanel.740aca88ab',
                'Workspace port scan failed.'
              )
          }
        )
      })
      .finally(() => {
        setWorkspacePortScanRefreshing(false)
      })
    return promise
  }, [
    activeRepoId,
    runtimeTarget,
    scanKey,
    replaceWorkspacePortScans,
    setWorkspacePortScanRefreshing
  ])

  // Scope WorkspacePortScanner's shared 30s results instead of starting another poll loop.
  const displayScan = isVisible && scanKey ? (scansByKey[scanKey] ?? null) : null
  const hasDisplayScan = displayScan !== null
  const firstScanRequestedKeyRef = useRef<string | null>(null)
  const { pending: firstScanPending, scan: scanFirstView } = useQuietPortScan()

  // Background scans publish silently, so opening the panel before any result scans once in view.
  useEffect(() => {
    if (
      !isVisible ||
      !runtimeTarget ||
      !scanKey ||
      hasDisplayScan ||
      firstScanRequestedKeyRef.current === scanKey
    ) {
      return
    }
    firstScanRequestedKeyRef.current = scanKey
    scanFirstView(runtimeTarget)
  }, [isVisible, runtimeTarget, scanKey, hasDisplayScan, scanFirstView])

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((current) => ({ ...current, [sectionId]: !current[sectionId] }))
  }, [])

  const handleStopPort = useCallback(
    async (port: WorkspacePort) => {
      if (!activeRepoId || !port.pid) {
        return
      }
      const result = await killWorkspacePortForTarget(runtimeTarget, {
        repoId: activeRepoId,
        pid: port.pid,
        port: port.port
      })
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
      const refreshResult = await refreshWorkspacePortScanAfterStop({
        runtimeTarget,
        replaceWorkspacePortScans,
        getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey,
        setWorkspacePortScanRefreshing
      })
      if (!refreshResult.ok) {
        toast.error(
          translate(
            'auto.components.right.sidebar.PortsPanel.a00f3a2840',
            'Failed to refresh ports'
          ),
          {
            description: refreshResult.reason
          }
        )
      }
    },
    [activeRepoId, runtimeTarget, replaceWorkspacePortScans, setWorkspacePortScanRefreshing]
  )

  const handleOpenPortInBrowser = useCallback(
    async (port: WorkspacePort, event?: React.MouseEvent<HTMLButtonElement>) => {
      const result = await openWorkspacePortInBrowser({
        port,
        activeWorktreeId: activeWorktree?.id,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle,
        openInOrcaBrowser: resolvePortOpenInOrcaBrowser({
          settings,
          event,
          isMac: navigator.userAgent.includes('Mac')
        }),
        localhostLabelRoute: resolveLocalhostLabelRouteForPort(useAppStore.getState(), port)
      })
      if (!result.ok) {
        toast.error(
          translate(
            'auto.components.right.sidebar.PortsPanel.98e9a414f8',
            'Failed to open browser'
          ),
          { description: result.reason }
        )
      }
    },
    [activeWorktree?.id, createBrowserTab, runtimeTarget, setRemoteBrowserPageHandle, settings]
  )

  const handleForwardPort = useCallback(
    (port: WorkspacePort) => {
      if (!sshForwardTargetId) {
        return
      }
      setForwardDialog({
        mode: 'add',
        defaults: {
          remotePort: port.port,
          remoteHost: portForwardRemoteHost(port.connectHost),
          label: port.processName,
          targetId: sshForwardTargetId
        }
      })
    },
    [sshForwardTargetId]
  )
  const isPortForwarded = useCallback(
    (port: WorkspacePort) => forwardedKeys.has(portForwardKey(port.connectHost, port.port)),
    [forwardedKeys]
  )
  const onForwardPort = canForward ? handleForwardPort : undefined

  const { activePorts, otherWorkspacePorts, externalPorts } = useMemo(
    () => getLocalWorkspacePortSections(displayScan, activeRepoId, activeWorktree?.id),
    [activeRepoId, activeWorktree?.id, displayScan]
  )

  const showPortSections = shouldShowLocalWorkspacePortSections(displayScan, {
    activePorts,
    otherWorkspacePorts,
    externalPorts
  })

  if (!activeRepoId) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
        <Server size={32} className="mb-3 opacity-50" />
        <p className="text-sm">
          {t('auto.components.right.sidebar.PortsPanel.c1b115c375', 'No workspace selected')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('auto.components.right.sidebar.PortsPanel.6bc058dbe1', 'Ports')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void refresh()}
              disabled={refreshing || !runtimeTarget}
              aria-label={t('auto.components.right.sidebar.PortsPanel.7822e3edc6', 'Refresh Ports')}
            >
              <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t('auto.components.right.sidebar.PortsPanel.7822e3edc6', 'Refresh Ports')}
          </TooltipContent>
        </Tooltip>
      </div>

      {sshForwardTargetId && (
        <SshForwardedPortsSection
          connectionId={sshForwardTargetId}
          onOpenDialog={setForwardDialog}
        />
      )}

      {displayScan?.unavailableReason && (
        <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
          {t(
            'auto.components.right.sidebar.PortsPanel.f59c783b7a',
            'Port scan unavailable on {{value0}}: {{value1}}',
            {
              value0: displayScan.platform,
              value1: displayScan.unavailableReason
            }
          )}
        </div>
      )}

      {showPortSections && (
        <>
          <LocalPortSection
            id="active"
            title={t('auto.components.right.sidebar.PortsPanel.935dda7718', 'Active Workspace')}
            ports={activePorts}
            emptyText={
              (refreshing || firstScanPending) && !displayScan
                ? t('auto.components.right.sidebar.PortsPanel.0d63d94db3', 'Scanning...')
                : t('auto.components.right.sidebar.PortsPanel.38b16cfbef', 'No ports detected')
            }
            collapsed={collapsedSections.active ?? false}
            onToggle={() => toggleSection('active')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
            onForwardPort={onForwardPort}
            isPortForwarded={isPortForwarded}
          />
          <LocalPortSection
            id="other"
            title={t('auto.components.right.sidebar.PortsPanel.4db4b5e435', 'Other Workspaces')}
            ports={otherWorkspacePorts}
            collapsed={collapsedSections.other ?? false}
            onToggle={() => toggleSection('other')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
            onForwardPort={onForwardPort}
            isPortForwarded={isPortForwarded}
          />
          <LocalPortSection
            id="external"
            title={t('auto.components.right.sidebar.PortsPanel.d32820d3e2', 'External')}
            ports={externalPorts}
            collapsed={collapsedSections.external ?? false}
            onToggle={() => toggleSection('external')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
            onForwardPort={onForwardPort}
            isPortForwarded={isPortForwarded}
          />
        </>
      )}

      {!displayScan?.unavailableReason &&
        displayScan &&
        activePorts.length === 0 &&
        otherWorkspacePorts.length === 0 &&
        externalPorts.length === 0 && (
          <div className="flex flex-col items-center justify-center flex-1 px-4 text-center text-muted-foreground">
            <Server size={32} className="mb-3 opacity-50" />
            <p className="text-sm">
              {t('auto.components.right.sidebar.PortsPanel.a2a9fc6899', 'No local ports detected')}
            </p>
          </div>
        )}

      <LocalPortDetailsDialog port={detailsPort} onClose={() => setDetailsPort(null)} />
      {/* Stays mounted across workspace switches; the open dialog keeps its pinned target. */}
      <SshPortForwardDialog
        state={forwardDialog}
        activeConnectionId={sshForwardTargetId}
        onClose={() => setForwardDialog({ mode: 'closed' })}
      />
    </div>
  )
}
