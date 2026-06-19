/* oxlint-disable max-lines -- Why: co-locates forwarded list, detected list, modal form, and
per-entry actions in one file to keep the data flow straightforward. */
import React, { useCallback, useMemo, useState } from 'react'
import {
  ExternalLink,
  Copy,
  Trash2,
  Plus,
  Unplug,
  ChevronRight,
  Pencil,
  RefreshCw,
  Server,
  Box,
  Info
} from 'lucide-react'
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
  scanWorkspacePortsForTarget,
  shouldOpenWorkspacePortInOrcaBrowser,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import {
  addressForPort,
  addressForPortForwardEntry,
  advertisedBrowserUrlForDetectedPort,
  advertisedBrowserUrlForForwardedRow,
  browserUrlForPortForwardEntry
} from '@/lib/workspace-port-urls'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { PortForwardEntry, EnrichedDetectedPort } from '../../../../shared/ssh-types'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { translate } from '@/i18n/i18n'

export {
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget
} from '@/lib/workspace-port-actions'

export function getLocalWorkspacePortSections(
  scan: { ports: WorkspacePort[] } | null | undefined,
  activeRepoId: string | null | undefined,
  activeWorktreeId: string | null | undefined
): {
  activePorts: WorkspacePort[]
  otherWorkspacePorts: WorkspacePort[]
  externalPorts: WorkspacePort[]
} {
  const ports = scan?.ports ?? []
  return {
    activePorts: ports.filter(
      (port) =>
        port.kind === 'workspace' &&
        port.owner.repoId === activeRepoId &&
        port.owner.worktreeId === activeWorktreeId
    ),
    otherWorkspacePorts: ports.filter(
      (port) =>
        port.kind === 'workspace' &&
        port.owner.repoId === activeRepoId &&
        port.owner.worktreeId !== activeWorktreeId
    ),
    // Why: the old repo-scoped scan showed listeners from other repos as
    // External, without workspace-only actions or cross-worktree activation.
    // Keep that behavior now that the shared scan can attribute them globally.
    externalPorts: ports.flatMap((port) => {
      if (port.kind !== 'workspace') {
        return [port]
      }
      return port.owner.repoId === activeRepoId ? [] : [workspacePortAsExternal(port)]
    })
  }
}

function workspacePortAsExternal(port: WorkspacePort & { kind: 'workspace' }): WorkspacePort {
  return {
    id: port.id,
    bindHost: port.bindHost,
    connectHost: port.connectHost,
    port: port.port,
    pid: port.pid,
    processName: port.processName,
    protocol: port.protocol,
    kind: 'external'
  }
}

const LOCAL_PORT_MENU_CONTENT_CLASS =
  '!rounded-md !border-border/60 !bg-popover !text-popover-foreground !shadow-[0_10px_24px_rgba(0,0,0,0.18)] !backdrop-blur-none'
const LOCAL_PORT_MENU_ITEM_CLASS =
  'rounded-md focus:bg-accent focus:text-accent-foreground dark:focus:bg-accent'
const LOCAL_PORT_MENU_LABEL_CLASS = 'px-2 py-1 text-[11px] font-semibold text-muted-foreground'

// Why: ports < 1024 require root to bind on the local machine. Remap them
// to a high port so the default "Forward" action doesn't fail with EACCES.
function safeLocalPort(remotePort: number): number {
  if (remotePort < 1024) {
    return remotePort + 10000
  }
  return remotePort
}

// Why: forwarded SSH ports and detected remote ports may report the same loopback
// endpoint using different textual hosts. Normalize for deduping only.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])
function normalizeHost(host: string | undefined): string {
  if (!host || LOOPBACK_HOSTS.has(host)) {
    return 'localhost'
  }
  return host
}

type PortForwardDialogState =
  | { mode: 'closed' }
  | {
      mode: 'add'
      defaults: { remotePort?: number; remoteHost?: string; label?: string; targetId?: string }
    }
  | { mode: 'edit'; entry: PortForwardEntry }

export default function PortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)

  if (activeRepo?.connectionId) {
    return <SshPortsPanel />
  }

  return <LocalWorkspacePortsPanel isVisible={isVisible} />
}

function LocalWorkspacePortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
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
    async (port: WorkspacePort) => {
      const result = await openWorkspacePortInBrowser({
        port,
        activeWorktreeId: activeWorktree?.id,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle,
        openInOrcaBrowser: shouldOpenWorkspacePortInOrcaBrowser(settings)
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

function LocalPortSection({
  id,
  title,
  ports,
  emptyText,
  collapsed,
  onToggle,
  onStopPort,
  onShowDetails,
  onOpenInBrowser
}: {
  id: string
  title: string
  ports: WorkspacePort[]
  emptyText?: string
  collapsed: boolean
  onToggle: () => void
  onStopPort: (port: WorkspacePort) => void
  onShowDetails: (port: WorkspacePort) => void
  onOpenInBrowser: (port: WorkspacePort) => void
}): React.JSX.Element | null {
  if (ports.length === 0 && !emptyText) {
    return null
  }

  return (
    <div className="px-3 pt-2">
      <button
        type="button"
        className="sticky top-0 z-10 mb-1 flex w-full items-center gap-1 border-b border-border/40 bg-background py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={`local-port-section-${id}`}
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform', !collapsed && 'rotate-90')}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {ports.length > 0 && (
          <span className="text-[10px] text-muted-foreground/60 ml-1">{ports.length}</span>
        )}
      </button>
      {!collapsed && (
        <div id={`local-port-section-${id}`}>
          {ports.length > 0
            ? ports.map((port) => (
                <LocalPortRow
                  key={port.id}
                  port={port}
                  onStop={onStopPort}
                  onShowDetails={onShowDetails}
                  onOpenInBrowser={onOpenInBrowser}
                />
              ))
            : emptyText && <div className="py-1 text-xs text-muted-foreground">{emptyText}</div>}
        </div>
      )}
    </div>
  )
}

function LocalPortRow({
  port,
  onStop,
  onShowDetails,
  onOpenInBrowser
}: {
  port: WorkspacePort
  onStop: (port: WorkspacePort) => void
  onShowDetails: (port: WorkspacePort) => void
  onOpenInBrowser: (port: WorkspacePort) => void
}): React.JSX.Element {
  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(addressForPort(port))
  }, [port])

  const handleOpenBrowser = useCallback(() => {
    void onOpenInBrowser(port)
  }, [onOpenInBrowser, port])

  const handleCopyButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      handleCopy()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleCopy]
  )

  const handleOpenBrowserButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      handleOpenBrowser()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleOpenBrowser]
  )

  const handleStopButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onStop(port)
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [onStop, port]
  )

  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  const address = addressForPort(port)
  const ownerLabel =
    port.kind === 'workspace'
      ? port.owner.displayName
      : port.kind === 'container'
        ? 'Container or forwarded service'
        : 'Unassigned'
  const confidenceLabel =
    port.kind === 'workspace' ? (port.owner.confidence === 'cwd' ? 'cwd' : 'command') : null
  const canStopProcess =
    port.kind === 'workspace' && Boolean(port.pid) && port.processName !== 'Electron'

  return (
    <ContextMenu>
      <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
        <ContextMenuTrigger asChild>
          <div
            className="flex min-w-0 flex-1 items-center gap-2 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            tabIndex={0}
            aria-label={translate(
              'auto.components.right.sidebar.PortsPanel.5be4f7f727',
              'Port {{value0}} menu',
              { value0: port.port }
            )}
          >
            <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {port.kind === 'container' ? <Box size={13} /> : <Server size={13} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">:{port.port}</span>
                <span className="truncate text-xs text-muted-foreground">{processLabel}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">{address}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                <span className="truncate">{ownerLabel}</span>
                {confidenceLabel && (
                  <span className="shrink-0 text-muted-foreground/70">{confidenceLabel}</span>
                )}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <TooltipProvider delayDuration={400}>
          <div className="flex items-center gap-0.5 can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleOpenBrowserButtonClick}
                  aria-label={translate(
                    'auto.components.right.sidebar.PortsPanel.b22b128b2a',
                    'Open in Browser'
                  )}
                >
                  <ExternalLink size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.right.sidebar.PortsPanel.b22b128b2a',
                  'Open in Browser'
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleCopyButtonClick}
                  aria-label={translate(
                    'auto.components.right.sidebar.PortsPanel.fe2730d050',
                    'Copy {{value0}}',
                    { value0: address }
                  )}
                >
                  <Copy size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.right.sidebar.PortsPanel.1004af16ab',
                  'Copy {{value0}}',
                  { value0: address }
                )}
              </TooltipContent>
            </Tooltip>
            {canStopProcess && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={handleStopButtonClick}
                    aria-label={translate(
                      'auto.components.right.sidebar.PortsPanel.f9528da632',
                      'Stop Process'
                    )}
                  >
                    <Trash2 size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate('auto.components.right.sidebar.PortsPanel.f9528da632', 'Stop Process')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>
      <ContextMenuContent className={LOCAL_PORT_MENU_CONTENT_CLASS}>
        <ContextMenuLabel
          className={LOCAL_PORT_MENU_LABEL_CLASS}
        >{`:${port.port}`}</ContextMenuLabel>
        <ContextMenuItem className={LOCAL_PORT_MENU_ITEM_CLASS} onSelect={handleOpenBrowser}>
          <ExternalLink size={13} />
          {translate('auto.components.right.sidebar.PortsPanel.b22b128b2a', 'Open in Browser')}
        </ContextMenuItem>
        <ContextMenuItem className={LOCAL_PORT_MENU_ITEM_CLASS} onSelect={handleCopy}>
          <Copy size={13} />
          {translate('auto.components.right.sidebar.PortsPanel.792baeb7ed', 'Copy Address')}
        </ContextMenuItem>
        <ContextMenuItem
          className={LOCAL_PORT_MENU_ITEM_CLASS}
          onSelect={() => {
            void window.api.ui.writeClipboardText(JSON.stringify(port, null, 2))
          }}
        >
          <Copy size={13} />
          {translate('auto.components.right.sidebar.PortsPanel.bdac206faf', 'Copy Details')}
        </ContextMenuItem>
        <ContextMenuItem
          className={LOCAL_PORT_MENU_ITEM_CLASS}
          onSelect={() => onShowDetails(port)}
        >
          <Info size={13} />
          {translate('auto.components.right.sidebar.PortsPanel.a223459512', 'Show Details')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={LOCAL_PORT_MENU_ITEM_CLASS}
          variant="destructive"
          disabled={!canStopProcess}
          onSelect={() => onStop(port)}
        >
          <Trash2 size={13} />
          {translate('auto.components.right.sidebar.PortsPanel.f9528da632', 'Stop Process')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function LocalPortDetailsDialog({
  port,
  onClose
}: {
  port: WorkspacePort | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={Boolean(port)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {port
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.472054d94c',
                  'Port :{{value0}}',
                  { value0: port.port }
                )
              : translate('auto.components.right.sidebar.PortsPanel.d41a8241ec', 'Port')}
          </DialogTitle>
          <DialogDescription>
            {port ? `${port.processName ?? 'Unknown process'} · ${addressForPort(port)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {port && (
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.1c1c18cefc', 'Address')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">{addressForPort(port)}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.0f1d8cd324', 'Bind')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">{`${port.bindHost}:${port.port}`}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.729be0b4e5', 'Kind')}
            </dt>
            <dd className="text-foreground">{port.kind}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.b1ff94fa27', 'Protocol')}
            </dt>
            <dd className="text-foreground">{port.protocol}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.5dd86dcf2f', 'Process')}
            </dt>
            <dd className="min-w-0 break-all text-foreground">
              {port.processName ??
                translate('auto.components.right.sidebar.PortsPanel.3e13cb63ee', 'Unknown')}
            </dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.57d930fa45', 'PID')}
            </dt>
            <dd className="text-foreground">
              {port.pid ??
                translate('auto.components.right.sidebar.PortsPanel.3e13cb63ee', 'Unknown')}
            </dd>
            {port.kind === 'workspace' && (
              <>
                <dt className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.PortsPanel.c7b4702b7b', 'Workspace')}
                </dt>
                <dd className="min-w-0 break-all text-foreground">{port.owner.displayName}</dd>
                <dt className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.PortsPanel.153145e675', 'Evidence')}
                </dt>
                <dd className="text-foreground">{port.owner.confidence}</dd>
              </>
            )}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SshPortsPanel(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const portForwardsByConnection = useAppStore((s) => s.portForwardsByConnection)
  const detectedPortsByConnection = useAppStore((s) => s.detectedPortsByConnection)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  // Why: scope the panel to the active worktree's SSH connection so
  // actions target the correct machine and the disconnected state
  // reflects the active worktree, not some other SSH session.
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeConnectionId = activeRepo?.connectionId ?? null

  const isDisconnected = activeConnectionId
    ? sshConnectionStates.get(activeConnectionId)?.status !== 'connected'
    : true

  const allForwards = useMemo(() => {
    if (!activeConnectionId) {
      return []
    }
    return portForwardsByConnection[activeConnectionId] ?? []
  }, [portForwardsByConnection, activeConnectionId])

  const forwardedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const f of allForwards) {
      set.add(`${normalizeHost(f.remoteHost)}:${f.remotePort}`)
    }
    return set
  }, [allForwards])

  const allDetected = useMemo(() => {
    if (!activeConnectionId) {
      return []
    }
    const ports = detectedPortsByConnection[activeConnectionId] ?? []
    return ports
      .filter((p) => !forwardedKeys.has(`${normalizeHost(p.host)}:${p.port}`))
      .map((p) => ({ ...p, targetId: activeConnectionId }))
      .sort((a, b) => a.port - b.port)
  }, [detectedPortsByConnection, activeConnectionId, forwardedKeys])

  const [forwardedCollapsed, setForwardedCollapsed] = useState(false)
  const [detectedCollapsed, setDetectedCollapsed] = useState(false)
  const [dialogState, setDialogState] = useState<PortForwardDialogState>({ mode: 'closed' })

  const handleForwardDetected = useCallback((port: EnrichedDetectedPort & { targetId: string }) => {
    setDialogState({
      mode: 'add',
      defaults: {
        remotePort: port.port,
        remoteHost: normalizeHost(port.host),
        label: port.processName,
        targetId: port.targetId
      }
    })
  }, [])

  const handleEdit = useCallback((entry: PortForwardEntry) => {
    setDialogState({ mode: 'edit', entry })
  }, [])

  const handleOpenForwardInBrowser = useCallback(
    (entry: PortForwardEntry) => {
      const url = browserUrlForPortForwardEntry(entry)
      if (!shouldOpenWorkspacePortInOrcaBrowser(settings)) {
        void window.api.shell.openUrl(url)
        return
      }
      if (!activeWorktree?.id) {
        toast.error(
          translate(
            'auto.components.right.sidebar.PortsPanel.409afcc145',
            'No workspace selected for the browser.'
          )
        )
        return
      }
      createBrowserTab(activeWorktree.id, url, {
        activate: true
      })
    },
    [activeWorktree?.id, createBrowserTab, settings]
  )

  const handleDialogClose = useCallback(() => {
    setDialogState({ mode: 'closed' })
  }, [])

  if (isDisconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
        <Unplug size={32} className="mb-3 opacity-50" />
        <p className="text-sm font-medium">
          {translate('auto.components.right.sidebar.PortsPanel.a2f1a47f42', 'SSH connection lost')}
        </p>
        <p className="text-xs mt-1">
          {translate('auto.components.right.sidebar.PortsPanel.d4c3cd679c', 'Reconnecting...')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.right.sidebar.PortsPanel.6bc058dbe1', 'Ports')}
        </span>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() =>
            setDialogState({ mode: 'add', defaults: { targetId: activeConnectionId ?? undefined } })
          }
        >
          <Plus size={14} />
          {translate('auto.components.right.sidebar.PortsPanel.a103dae837', 'Add')}
        </button>
      </div>

      {/* Forwarded ports */}
      {allForwards.length > 0 && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className="flex items-center gap-1 w-full text-left mb-1"
            onClick={() => setForwardedCollapsed((v) => !v)}
          >
            <ChevronRight
              size={12}
              className={cn(
                'text-muted-foreground transition-transform',
                !forwardedCollapsed && 'rotate-90'
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.ddbe58d74e', 'Forwarded')}
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allForwards.length}</span>
          </button>
          {!forwardedCollapsed &&
            allForwards.map((entry) => (
              <ForwardedPortRow
                key={entry.id}
                entry={entry}
                onEdit={() => handleEdit(entry)}
                onOpenInBrowser={() => handleOpenForwardInBrowser(entry)}
              />
            ))}
        </div>
      )}

      {/* Detected ports */}
      {allDetected.length > 0 && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className="flex items-center gap-1 w-full text-left mb-1"
            onClick={() => setDetectedCollapsed((v) => !v)}
          >
            <ChevronRight
              size={12}
              className={cn(
                'text-muted-foreground transition-transform',
                !detectedCollapsed && 'rotate-90'
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {translate('auto.components.right.sidebar.PortsPanel.36b1b2984a', 'Detected')}
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allDetected.length}</span>
          </button>
          {!detectedCollapsed &&
            allDetected.map((port) => (
              <DetectedPortRow
                key={`${port.targetId}-${port.host}-${port.port}`}
                port={port}
                onForward={() => handleForwardDetected(port)}
              />
            ))}
        </div>
      )}

      {/* Empty state */}
      {allForwards.length === 0 && allDetected.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 px-4 text-center text-muted-foreground">
          <p className="text-sm">
            {translate('auto.components.right.sidebar.PortsPanel.1f0d2a24f9', 'No forwarded ports')}
          </p>
          <p className="text-xs mt-1 mb-3">
            {translate(
              'auto.components.right.sidebar.PortsPanel.04efd3dad4',
              'Forward a port to access remote services on your local machine.'
            )}
          </p>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={() =>
              setDialogState({
                mode: 'add',
                defaults: { targetId: activeConnectionId ?? undefined }
              })
            }
          >
            {translate('auto.components.right.sidebar.PortsPanel.907eb53ed2', 'Forward a Port')}
          </button>
        </div>
      )}

      <PortForwardDialog
        state={dialogState}
        activeConnectionId={activeConnectionId}
        onClose={handleDialogClose}
      />
    </div>
  )
}

function ForwardedPortRow({
  entry,
  onEdit,
  onOpenInBrowser
}: {
  entry: PortForwardEntry
  onEdit: () => void
  onOpenInBrowser: () => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState(false)
  const mountedRef = useMountedRef()
  const forwardedAddress = addressForPortForwardEntry(entry)

  const handleRemove = useCallback(async () => {
    setRemoving(true)
    try {
      await window.api.ssh.removePortForward({ id: entry.id })
    } catch {
      // broadcast will update state
    }
    if (mountedRef.current) {
      setRemoving(false)
    }
  }, [entry.id, mountedRef])

  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(forwardedAddress)
  }, [forwardedAddress])

  const handleOpenBrowser = useCallback(() => {
    onOpenInBrowser()
  }, [onOpenInBrowser])

  const handleCopyButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      handleCopy()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleCopy]
  )

  const handleOpenBrowserButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      handleOpenBrowser()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleOpenBrowser]
  )

  const handleEditButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onEdit()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [onEdit]
  )

  const handleRemoveButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      void handleRemove()
      if (event.detail > 0) {
        event.currentTarget.blur()
      }
    },
    [handleRemove]
  )

  const advertisedBrowserUrl = advertisedBrowserUrlForForwardedRow(entry)

  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {entry.label && (
            <span className="text-xs font-medium text-foreground truncate">{entry.label}</span>
          )}
          <span
            className={cn(
              'text-xs text-muted-foreground truncate',
              !entry.label && 'text-foreground'
            )}
          >
            :{entry.localPort} → :{entry.remotePort}
          </span>
        </div>
        {advertisedBrowserUrl && (
          <div className="text-[11px] text-muted-foreground/70 truncate">
            {translate('auto.components.right.sidebar.PortsPanel.de349d4560', 'opens {{value0}}', {
              value0: advertisedBrowserUrl
            })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleOpenBrowserButtonClick}
          title={
            advertisedBrowserUrl
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.75aeea592f',
                  'Open {{value0}} in Browser',
                  { value0: advertisedBrowserUrl }
                )
              : translate('auto.components.right.sidebar.PortsPanel.b22b128b2a', 'Open in Browser')
          }
        >
          <ExternalLink size={13} />
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleCopyButtonClick}
          title={translate(
            'auto.components.right.sidebar.PortsPanel.1004af16ab',
            'Copy {{value0}}',
            { value0: forwardedAddress }
          )}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleEditButtonClick}
          title={translate('auto.components.right.sidebar.PortsPanel.b3548e59f4', 'Edit')}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground',
            removing && 'opacity-50'
          )}
          onClick={handleRemoveButtonClick}
          disabled={removing}
          title={translate('auto.components.right.sidebar.PortsPanel.e740075063', 'Remove')}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function DetectedPortRow({
  port,
  onForward
}: {
  port: EnrichedDetectedPort & { targetId: string }
  onForward: () => void
}): React.JSX.Element {
  const advertisedBrowserUrl = advertisedBrowserUrlForDetectedPort(port)
  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-foreground">:{port.port}</span>
          {port.processName && (
            <span className="text-xs text-muted-foreground truncate">{port.processName}</span>
          )}
        </div>
        {advertisedBrowserUrl && (
          <div className="text-[11px] text-muted-foreground/70 truncate">
            {translate(
              'auto.components.right.sidebar.PortsPanel.c7e920aa7c',
              'advertised as {{value0}}',
              { value0: advertisedBrowserUrl }
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="text-[11px] px-2 py-0.5 rounded can-hover:opacity-0 group-hover:opacity-100 transition-opacity bg-accent hover:bg-accent/80 text-foreground"
        onClick={onForward}
      >
        {translate('auto.components.right.sidebar.PortsPanel.c9d106547a', 'Forward')}
      </button>
    </div>
  )
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

const INPUT_CLASS =
  'block w-full mt-0.5 px-2 py-1.5 text-xs rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function PortForwardDialog({
  state,
  activeConnectionId,
  onClose
}: {
  state: PortForwardDialogState
  activeConnectionId: string | null
  onClose: () => void
}): React.JSX.Element {
  const isOpen = state.mode !== 'closed'
  const isEdit = state.mode === 'edit'

  const initialRemotePort =
    state.mode === 'edit'
      ? state.entry.remotePort.toString()
      : state.mode === 'add'
        ? (state.defaults.remotePort?.toString() ?? '')
        : ''

  const initialLocalPort =
    state.mode === 'edit'
      ? state.entry.localPort.toString()
      : state.mode === 'add' && state.defaults.remotePort != null
        ? safeLocalPort(state.defaults.remotePort).toString()
        : ''

  const initialRemoteHost =
    state.mode === 'edit'
      ? state.entry.remoteHost
      : state.mode === 'add'
        ? (state.defaults.remoteHost ?? 'localhost')
        : 'localhost'

  const initialLabel =
    state.mode === 'edit'
      ? (state.entry.label ?? '')
      : state.mode === 'add'
        ? (state.defaults.label ?? '')
        : ''

  // Why: capture the target at dialog-open time via defaults.targetId so
  // switching worktrees while the dialog is open doesn't redirect the
  // forward to the wrong SSH connection.
  const targetId =
    state.mode === 'edit'
      ? state.entry.connectionId
      : state.mode === 'add'
        ? (state.defaults.targetId ?? activeConnectionId ?? '')
        : (activeConnectionId ?? '')

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[340px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isEdit
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.80206251c8',
                  'Edit Port Forward'
                )
              : translate('auto.components.right.sidebar.PortsPanel.907eb53ed2', 'Forward a Port')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.10360598a4',
                  'Update the port forwarding configuration.'
                )
              : translate(
                  'auto.components.right.sidebar.PortsPanel.31e80cff2d',
                  'Forward a remote port to your local machine.'
                )}
          </DialogDescription>
        </DialogHeader>
        {isOpen && (
          <PortForwardForm
            key={
              state.mode === 'edit'
                ? `edit-${state.entry.id}`
                : `add-${targetId}-${initialRemotePort}-${initialRemoteHost}`
            }
            mode={state.mode}
            editId={state.mode === 'edit' ? state.entry.id : undefined}
            initialRemotePort={initialRemotePort}
            initialLocalPort={initialLocalPort}
            initialRemoteHost={initialRemoteHost}
            initialLabel={initialLabel}
            targetId={targetId}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PortForwardForm({
  mode,
  editId,
  initialRemotePort,
  initialLocalPort,
  initialRemoteHost,
  initialLabel,
  targetId,
  onClose
}: {
  mode: 'add' | 'edit'
  editId?: string
  initialRemotePort: string
  initialLocalPort: string
  initialRemoteHost: string
  initialLabel: string
  targetId: string
  onClose: () => void
}): React.JSX.Element {
  const [remotePort, setRemotePort] = useState(initialRemotePort)
  const [localPort, setLocalPort] = useState(initialLocalPort)
  const [remoteHost, setRemoteHost] = useState(initialRemoteHost)
  const [label, setLabel] = useState(initialLabel)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      const rPort = parseInt(remotePort, 10)
      const lPort = parseInt(localPort || remotePort, 10)

      if (isNaN(rPort) || rPort < 1 || rPort > 65535) {
        setError('Remote port must be 1\u201365535')
        return
      }
      if (isNaN(lPort) || lPort < 1 || lPort > 65535) {
        setError('Local port must be 1\u201365535')
        return
      }

      setSubmitting(true)
      try {
        await (mode === 'edit' && editId
          ? window.api.ssh.updatePortForward({
              id: editId,
              targetId,
              localPort: lPort,
              remoteHost: remoteHost || 'localhost',
              remotePort: rPort,
              label: label || undefined
            })
          : window.api.ssh.addPortForward({
              targetId,
              localPort: lPort,
              remoteHost: remoteHost || 'localhost',
              remotePort: rPort,
              label: label || undefined
            }))
        onClose()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('EADDRINUSE') || msg.includes('already in use')) {
          setError(`Port ${lPort} is already in use. Choose a different local port.`)
        } else if (msg.includes('EACCES') || msg.includes('permission denied')) {
          setError(`Port ${lPort} requires elevated privileges. Use a local port \u2265 1024.`)
        } else {
          setError(msg)
        }
      }
      setSubmitting(false)
    },
    [mode, editId, remotePort, localPort, remoteHost, label, targetId, onClose]
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.9e5a4118b0', 'Remote Port')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={remotePort}
            onChange={(e) => {
              const val = digitsOnly(e.target.value)
              setRemotePort(val)
              const prev = parseInt(remotePort, 10)
              const cur = parseInt(localPort, 10)
              if (!localPort || cur === prev || cur === safeLocalPort(prev)) {
                const parsed = parseInt(val, 10)
                setLocalPort(isNaN(parsed) ? '' : safeLocalPort(parsed).toString())
              }
            }}
            className={INPUT_CLASS}
            placeholder="3000"
            autoFocus
            required
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.b950b1948b', 'Local Port')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={localPort}
            onChange={(e) => setLocalPort(digitsOnly(e.target.value))}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.d57545ff92',
              'Same as remote'
            )}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.a3721a50b0', 'Remote Host')}
          </span>
          <input
            type="text"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.17bea6e391',
              'localhost'
            )}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.8dfed0a15c', 'Label (optional)')}
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.4eb801ce93',
              'dev-server'
            )}
          />
        </label>
      </div>

      {error && <div className="text-[11px] text-destructive">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {translate('auto.components.right.sidebar.PortsPanel.3ea4a02a8f', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !remotePort}>
          {submitting
            ? mode === 'edit'
              ? translate('auto.components.right.sidebar.PortsPanel.d7c83cfd24', 'Saving...')
              : translate('auto.components.right.sidebar.PortsPanel.9f475dc994', 'Forwarding...')
            : mode === 'edit'
              ? translate('auto.components.right.sidebar.PortsPanel.9079776663', 'Save')
              : translate('auto.components.right.sidebar.PortsPanel.c9d106547a', 'Forward')}
        </Button>
      </div>
    </form>
  )
}
