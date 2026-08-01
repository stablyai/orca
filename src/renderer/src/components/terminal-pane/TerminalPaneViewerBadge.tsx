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
// Why: a freshly opened pane's PTY registers in the runtime graph after this
// badge mounts, so a single resolve attempt would come back empty and hide the
// badge for the pane's lifetime — keep retrying until the pane resolves.
const HANDLE_RESOLVE_RETRY_MS = 2000

export function TerminalPaneViewerBadge({
  tabId,
  leafId,
  connectedClients,
  onConnectedClientsChanged
}: TerminalPaneViewerBadgeProps): React.JSX.Element | null {
  const [handle, setHandle] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: number | null = null
    const callRuntime = window.api?.runtime?.call
    if (!callRuntime) {
      return
    }
    setHandle(null)
    const attempt = (): void => {
      void resolveTerminalHandleForPane({ tabId, leafId, callRuntime })
        .then((resolved) => {
          if (disposed) {
            return
          }
          if (resolved) {
            setHandle(resolved)
          } else {
            timer = window.setTimeout(attempt, HANDLE_RESOLVE_RETRY_MS)
          }
        })
        .catch(() => {
          if (!disposed) {
            timer = window.setTimeout(attempt, HANDLE_RESOLVE_RETRY_MS)
          }
        })
    }
    attempt()
    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [tabId, leafId])

  if (connectedClients.length === 0 || !handle) {
    return null
  }

  const viewers = connectedClients.filter((client) => client.subscribedTerminals.includes(handle))
  const others = connectedClients.filter((client) => !client.subscribedTerminals.includes(handle))
  const grantedCount = connectedClients.filter((client) =>
    client.grantedTerminals.includes(handle)
  ).length

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
      : grantedCount > 0
        ? translate(
            'components.terminalPaneViewerBadge.grantedCount',
            '{{count}} granted access to this terminal',
            { count: grantedCount }
          )
        : translate(
            'components.terminalPaneViewerBadge.noneGranted',
            '{{count}} connected, no access granted to this terminal',
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
                <Users
                  className={
                    grantedCount > 0 ? 'text-foreground size-3' : 'text-muted-foreground size-3'
                  }
                />
              )}
              <span
                className={
                  viewers.length > 0
                    ? 'tabular-nums'
                    : grantedCount > 0
                      ? 'text-foreground tabular-nums'
                      : 'text-muted-foreground tabular-nums'
                }
              >
                {viewers.length > 0 ? viewers.length : grantedCount}
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
