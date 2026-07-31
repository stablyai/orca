import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Eye, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ConnectedPeerClient } from '@/components/settings/PeerCollabConnectedClientsSection'
import { resolveTerminalHandleForPane } from './terminal-handle-copy'
import { TerminalPaneViewerBadgeClientRow } from './TerminalPaneViewerBadgeClientRow'

type TerminalPaneViewerBadgeProps = {
  tabId: string
  leafId: string
  connectedClients: readonly ConnectedPeerClient[]
  onConnectedClientsChanged: () => Promise<void>
}

/**
 * Shows a badge in the pane title cluster whenever peer devices are
 * connected, letting the host share (grant) this pane's terminal to them and
 * see who is currently watching it. Renders nothing when no client is
 * connected (or peer collab is inactive).
 */
export function TerminalPaneViewerBadge({
  tabId,
  leafId,
  connectedClients,
  onConnectedClientsChanged
}: TerminalPaneViewerBadgeProps): React.JSX.Element | null {
  const [handle, setHandle] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const callRuntime = window.api?.runtime?.call
    if (!callRuntime) {
      return
    }
    void resolveTerminalHandleForPane({ tabId, leafId, callRuntime })
      .then((resolved) => {
        if (!disposed) {
          setHandle(resolved)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [tabId, leafId])

  if (connectedClients.length === 0 || !handle) {
    return null
  }

  const viewers = connectedClients.filter((client) => client.subscribedTerminals.includes(handle))
  const others = connectedClients.filter((client) => !client.subscribedTerminals.includes(handle))

  async function disconnectViewer(deviceId: string): Promise<void> {
    try {
      await window.api?.peerCollab?.disconnectClient({ deviceId, revokeDevice: false })
    } catch {
      toast.error(
        translate(
          'components.terminalPaneViewerBadge.disconnectFailed',
          'Failed to disconnect client'
        )
      )
    } finally {
      await onConnectedClientsChanged()
    }
  }

  async function setGrantedTerminals(deviceId: string, handles: string[]): Promise<void> {
    try {
      await window.api?.peerCollab?.setGrantedTerminals({ deviceId, handles })
    } catch {
      toast.error(
        translate(
          'components.terminalPaneViewerBadge.shareToggleFailed',
          'Failed to update shared terminal'
        )
      )
    } finally {
      await onConnectedClientsChanged()
    }
  }

  const badgeLabel =
    viewers.length > 0
      ? translate(
          'components.terminalPaneViewerBadge.viewerCount',
          '{{count}} viewing this terminal',
          { count: viewers.length }
        )
      : translate(
          'components.terminalPaneViewerBadge.connectedNotWatching',
          '{{count}} connected, not watching',
          { count: connectedClients.length }
        )

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="pane-title-split-trigger pane-title-viewer-badge"
              aria-label={badgeLabel}
              onClick={(event) => event.stopPropagation()}
            >
              {viewers.length > 0 ? (
                <Eye className="size-3" />
              ) : (
                <Users className="text-muted-foreground size-3" />
              )}
              <span
                className={
                  viewers.length > 0 ? 'tabular-nums' : 'text-muted-foreground tabular-nums'
                }
              >
                {viewers.length > 0 ? viewers.length : connectedClients.length}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {badgeLabel}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2" onClick={(event) => event.stopPropagation()}>
        <div className="space-y-1">
          {viewers.map((client) => (
            <TerminalPaneViewerBadgeClientRow
              key={client.connectionId}
              client={client}
              handle={handle}
              isWatching
              onToggleGrant={(deviceId, handles) => void setGrantedTerminals(deviceId, handles)}
              onDisconnect={(deviceId) => void disconnectViewer(deviceId)}
            />
          ))}
          {viewers.length > 0 && others.length > 0 ? <div className="bg-border my-1 h-px" /> : null}
          {others.map((client) => (
            <TerminalPaneViewerBadgeClientRow
              key={client.connectionId}
              client={client}
              handle={handle}
              isWatching={false}
              onToggleGrant={(deviceId, handles) => void setGrantedTerminals(deviceId, handles)}
              onDisconnect={(deviceId) => void disconnectViewer(deviceId)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
