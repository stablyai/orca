import React, { useCallback } from 'react'
import { Box, Copy, ExternalLink, Info, Server, Trash2 } from 'lucide-react'
import { getPortOpenBrowserTooltipLabel } from '@/lib/workspace-port-actions'
import { addressForPort } from '@/lib/workspace-port-urls'
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
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { translate } from '@/i18n/i18n'

const LOCAL_PORT_MENU_CONTENT_CLASS =
  '!rounded-md !border-border/60 !bg-popover !text-popover-foreground !shadow-[0_10px_24px_rgba(0,0,0,0.18)] !backdrop-blur-none'
const LOCAL_PORT_MENU_ITEM_CLASS =
  'rounded-md focus:bg-accent focus:text-accent-foreground dark:focus:bg-accent'
const LOCAL_PORT_MENU_LABEL_CLASS = 'px-2 py-1 text-[11px] font-semibold text-muted-foreground'

export function LocalPortRow({
  port,
  onStop,
  onShowDetails,
  onOpenInBrowser
}: {
  port: WorkspacePort
  onStop: (port: WorkspacePort) => void
  onShowDetails: (port: WorkspacePort) => void
  onOpenInBrowser: (port: WorkspacePort, event?: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(addressForPort(port))
  }, [port])

  const handleOpenBrowser = useCallback(
    (event?: React.MouseEvent<HTMLButtonElement>) => {
      void onOpenInBrowser(port, event)
    },
    [onOpenInBrowser, port]
  )

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
      // Why: keyboard activations have detail=0; only pointer clicks carry
      // the modifier intent for the system-browser escape hatch.
      handleOpenBrowser(event.detail > 0 ? event : undefined)
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
  const openBrowserLabel = translate(
    'auto.components.right.sidebar.PortsPanel.b22b128b2a',
    'Open in Browser'
  )
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
                  aria-label={openBrowserLabel}
                >
                  <ExternalLink size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {getPortOpenBrowserTooltipLabel(openBrowserLabel)}
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
        <ContextMenuItem
          className={LOCAL_PORT_MENU_ITEM_CLASS}
          onSelect={() => handleOpenBrowser()}
        >
          <ExternalLink size={13} />
          {openBrowserLabel}
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
