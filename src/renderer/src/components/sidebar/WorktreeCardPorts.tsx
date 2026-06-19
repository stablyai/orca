import React, { useCallback, useMemo } from 'react'
import { Plug, Copy, ExternalLink, FolderOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  canStopWorkspacePort,
  goToWorkspacePortOwner,
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  refreshWorkspacePortScanAfterStop,
  shouldOpenWorkspacePortInOrcaBrowser
} from '@/lib/workspace-port-actions'
import { addressForPort } from '@/lib/workspace-port-urls'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from './WorktreeContextMenu'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { translate } from '@/i18n/i18n'

type WorktreeCardPortsProps = {
  ports: WorkspacePort[]
}

export function WorktreeCardPortsTrigger({
  ports
}: WorktreeCardPortsProps): React.JSX.Element | null {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  if (ports.length === 0) {
    return null
  }

  return (
    <button
      type="button"
      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
      aria-label={translate(
        'auto.components.sidebar.WorktreeCardPorts.fed49903c9',
        '{{value0}} live {{value1}}',
        { value0: ports.length, value1: ports.length === 1 ? 'port' : 'ports' }
      )}
      onClick={(event) => {
        event.stopPropagation()
        recordFeatureInteraction('ports')
      }}
    >
      <Plug className="size-3.5" />
    </button>
  )
}

function PortAction({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    onClick(event)
    if (event.detail > 0) {
      event.currentTarget.blur()
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          className="size-5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35"
          aria-label={label}
          onClick={handleClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function WorktreePortRow({ port }: { port: WorkspacePort }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, port.kind === 'workspace' ? port.owner.worktreeId : null)
  )
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanForKey = useAppStore((s) => s.setWorkspacePortScanForKey)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ ...settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }),
    [runtimeEnvironmentId, settings]
  )
  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  const address = addressForPort(port)
  const canStop = canStopWorkspacePort(port)

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      void openWorkspacePortInBrowser({
        port,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle,
        openInOrcaBrowser: shouldOpenWorkspacePortInOrcaBrowser(settings)
      }).then((result) => {
        if (!result.ok) {
          toast.error(
            translate(
              'auto.components.sidebar.WorktreeCardPorts.d1113f4660',
              'Failed to open browser'
            ),
            { description: result.reason }
          )
        }
      })
    },
    [
      createBrowserTab,
      port,
      recordFeatureInteraction,
      runtimeTarget,
      setRemoteBrowserPageHandle,
      settings
    ]
  )

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      const address = addressForPort(port)
      void window.api.ui.writeClipboardText(address)
      toast.success(
        translate('auto.components.sidebar.WorktreeCardPorts.c89f290e25', 'Copied {{value0}}', {
          value0: address
        })
      )
    },
    [port, recordFeatureInteraction]
  )

  const handleStop = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!canStopWorkspacePort(port)) {
        return
      }
      recordFeatureInteraction('ports')
      const run = async (): Promise<void> => {
        const result = await killWorkspacePortForTarget(runtimeTarget, {
          repoId: port.owner.repoId,
          pid: port.pid,
          port: port.port
        })
        if (!result.ok) {
          toast.error(result.reason)
          return
        }
        toast.success(
          translate(
            'auto.components.sidebar.WorktreeCardPorts.5d1a5d51bb',
            'Stopped process on {{value0}}',
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
              'auto.components.sidebar.WorktreeCardPorts.9950fe2d20',
              'Failed to refresh ports'
            ),
            {
              description: refreshResult.reason
            }
          )
        }
      }
      void run()
    },
    [
      port,
      recordFeatureInteraction,
      runtimeTarget,
      setWorkspacePortScan,
      setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing
    ]
  )

  return (
    <div className="group/port grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/50">
      <span className="select-text font-mono text-[12px] font-semibold tabular-nums text-foreground">
        {port.port}
      </span>
      <div className="relative flex h-5 min-w-0 items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex min-w-0 select-text items-baseline gap-1 overflow-hidden pr-[3.75rem] text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{processLabel}</span>
              <span className="shrink-0 text-muted-foreground/45">-</span>
              <span className="min-w-0 flex-[1.1] truncate text-muted-foreground/70">
                {address}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span className="flex items-center gap-1.5">
              <span>{processLabel}</span>
              <span className="text-muted-foreground/60">-</span>
              <span>{address}</span>
            </span>
          </TooltipContent>
        </Tooltip>
        <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-md border border-border/40 bg-popover/95 px-0.5 can-hover:opacity-0 shadow-xs transition-opacity group-hover/port:opacity-100 group-focus-within/port:opacity-100">
          <PortAction
            label={translate(
              'auto.components.sidebar.WorktreeCardPorts.33bc7d7495',
              'Open in Browser'
            )}
            onClick={handleOpen}
          >
            <ExternalLink className="size-3" />
          </PortAction>
          <PortAction
            label={translate(
              'auto.components.sidebar.WorktreeCardPorts.c8067a829a',
              'Copy {{value0}}',
              { value0: address }
            )}
            onClick={handleCopy}
          >
            <Copy className="size-3" />
          </PortAction>
          <PortAction
            label={translate(
              'auto.components.sidebar.WorktreeCardPorts.2f854442ff',
              'Stop Process'
            )}
            disabled={!canStop}
            onClick={handleStop}
          >
            <Trash2 className="size-3" />
          </PortAction>
        </div>
      </div>
    </div>
  )
}

export function WorktreeCardPortsDetails({
  ports
}: WorktreeCardPortsProps): React.JSX.Element | null {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const handleGoToWorktree = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      const ownerPort = ports[0]
      if (!ownerPort || !goToWorkspacePortOwner(ownerPort)) {
        toast.error(
          translate('auto.components.sidebar.WorktreeCardPorts.3e5f66564e', 'Workspace unavailable')
        )
      }
    },
    [ports, recordFeatureInteraction]
  )

  if (ports.length === 0) {
    return null
  }

  return (
    <WorktreeCardDetailSection>
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <Plug className="size-3" />
        <span>
          {translate('auto.components.sidebar.WorktreeCardPorts.3240f320d7', 'Live Ports')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <PortAction
            label={translate(
              'auto.components.sidebar.WorktreeCardPorts.34f733dda2',
              'Go to Worktree'
            )}
            onClick={handleGoToWorktree}
          >
            <FolderOpen className="size-3" />
          </PortAction>
          <span className="font-normal tabular-nums text-muted-foreground/70">{ports.length}</span>
        </div>
      </div>
      <WorktreeCardDetailSectionContent className="space-y-0.5">
        {ports.map((port) => (
          <WorktreePortRow key={port.id} port={port} />
        ))}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}

export function WorktreeCardPorts({ ports }: WorktreeCardPortsProps): React.JSX.Element | null {
  if (ports.length === 0) {
    return null
  }

  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <WorktreeCardPortsTrigger ports={ports} />
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-56 select-text p-2 text-xs"
        {...{ [WORKTREE_NATIVE_CONTEXT_MENU_ATTR]: '' }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <SelectedTextCopyMenu>
          <WorktreeCardPortsDetails ports={ports} />
        </SelectedTextCopyMenu>
      </HoverCardContent>
    </HoverCard>
  )
}
