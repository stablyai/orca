import React, { useCallback, useMemo, useState } from 'react'
import { RefreshCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  refreshWorkspacePortScanAfterStop,
  resolvePortOpenInOrcaBrowser,
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import { resolveLocalhostLabelRouteForPort } from '@/lib/workspace-port-localhost-label-selector'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { translate } from '@/i18n/i18n'
import { getLocalWorkspacePortSections } from './local-workspace-port-sections'
import { LocalPortSection } from './local-port-section'
import { LocalPortDetailsDialog } from './local-port-details-dialog'

export function LocalWorkspacePortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const settings = useAppStore((s) => s.settings)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const scansByKey = useAppStore((s) => s.workspacePortScansByKey)
  const refreshing = useAppStore((s) => s.workspacePortScanRefreshing)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanForKey = useAppStore((s) => s.setWorkspacePortScanForKey)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const [detailsPort, setDetailsPort] = useState<WorkspacePort | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    other: true,
    external: true
  })

  const runtimeTarget = useMemo(() => {
    const activeRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      useAppStore.getState(),
      activeWorktree?.id
    )
    // Why: the Ports panel acts on the active workspace; use that workspace's
    // host owner even if the sidebar is focused elsewhere.
    return getActiveRuntimeTarget({ ...settings, activeRuntimeEnvironmentId })
  }, [activeWorktree?.id, settings])
  const scanKey = `${workspacePortRuntimeTargetKey(runtimeTarget)}:all`

  const refresh = useCallback(() => {
    if (!activeRepo) {
      return Promise.resolve()
    }
    setWorkspacePortScanRefreshing(true)
    const promise = scanWorkspacePortsForTarget(runtimeTarget)
      .then((nextScan) => {
        setWorkspacePortScanForKey(scanKey, nextScan)
        setWorkspacePortScan({ key: scanKey, result: nextScan })
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
    activeRepo,
    runtimeTarget,
    scanKey,
    setWorkspacePortScan,
    setWorkspacePortScanForKey,
    setWorkspacePortScanRefreshing
  ])

  // Why: WorkspacePortScanner already owns the 30s all-worktree poll. The
  // panel scopes that shared result instead of starting a second scan loop.
  const displayScan = isVisible ? (scansByKey[scanKey] ?? null) : null

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((current) => ({ ...current, [sectionId]: !current[sectionId] }))
  }, [])

  const handleStopPort = useCallback(
    async (port: WorkspacePort) => {
      if (!activeRepo || !port.pid) {
        return
      }
      const result = await killWorkspacePortForTarget(runtimeTarget, {
        repoId: activeRepo.id,
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
        setWorkspacePortScan,
        setWorkspacePortScanForKey,
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
    [
      activeRepo,
      runtimeTarget,
      setWorkspacePortScan,
      setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing
    ]
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

  const { activePorts, otherWorkspacePorts, externalPorts } = useMemo(
    () => getLocalWorkspacePortSections(displayScan, activeRepo?.id, activeWorktree?.id),
    [activeRepo?.id, activeWorktree?.id, displayScan]
  )

  if (!activeRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
        <Server size={32} className="mb-3 opacity-50" />
        <p className="text-sm">
          {translate(
            'auto.components.right.sidebar.PortsPanel.c1b115c375',
            'No workspace selected'
          )}
        </p>
      </div>
    )
  }

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

      {displayScan?.unavailableReason && (
        <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
          {translate(
            'auto.components.right.sidebar.PortsPanel.f59c783b7a',
            'Port scan unavailable on {{value0}}: {{value1}}',
            {
              value0: displayScan.platform,
              value1: displayScan.unavailableReason
            }
          )}
        </div>
      )}

      {!displayScan?.unavailableReason && (
        <>
          <LocalPortSection
            id="active"
            title={translate(
              'auto.components.right.sidebar.PortsPanel.935dda7718',
              'Active Workspace'
            )}
            ports={activePorts}
            emptyText={
              refreshing && !displayScan
                ? translate('auto.components.right.sidebar.PortsPanel.0d63d94db3', 'Scanning...')
                : translate(
                    'auto.components.right.sidebar.PortsPanel.38b16cfbef',
                    'No ports detected'
                  )
            }
            collapsed={collapsedSections.active ?? false}
            onToggle={() => toggleSection('active')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
          />
          <LocalPortSection
            id="other"
            title={translate(
              'auto.components.right.sidebar.PortsPanel.4db4b5e435',
              'Other Workspaces'
            )}
            ports={otherWorkspacePorts}
            collapsed={collapsedSections.other ?? false}
            onToggle={() => toggleSection('other')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
          />
          <LocalPortSection
            id="external"
            title={translate('auto.components.right.sidebar.PortsPanel.d32820d3e2', 'External')}
            ports={externalPorts}
            collapsed={collapsedSections.external ?? false}
            onToggle={() => toggleSection('external')}
            onStopPort={(port) => void handleStopPort(port)}
            onShowDetails={setDetailsPort}
            onOpenInBrowser={handleOpenPortInBrowser}
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
              {translate(
                'auto.components.right.sidebar.PortsPanel.a2a9fc6899',
                'No local ports detected'
              )}
            </p>
          </div>
        )}

      <LocalPortDetailsDialog port={detailsPort} onClose={() => setDetailsPort(null)} />
    </div>
  )
}
