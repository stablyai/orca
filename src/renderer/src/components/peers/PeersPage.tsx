import { useEffect } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PeerClientStatus } from '../../../../shared/peer-client-status'
import { usePeerCollabClientConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import { RemoteTerminalPanel } from '@/components/peer-collab/RemoteTerminalPanel'
import { PeersEmptyState } from './PeersEmptyState'
import { usePeersPageEscape } from './use-peers-page-escape'

function connectionBadgeLabel(state: PeerClientStatus['state']): string {
  if (state === 'connected') {
    return translate('auto.components.peers.PeersPage.a4c1e8f0b7', 'Connected')
  }
  if (state === 'reconnect-wait' || state === 'connecting') {
    return translate('auto.components.peers.PeersPage.b8d3a6c2e9', 'Reconnecting')
  }
  return translate('auto.components.peers.PeersPage.c2e9f5a1d8', 'Disconnected')
}

export default function PeersPage(): React.JSX.Element {
  const { hostTerminals, clientStatus } = usePeerCollabClientConnection()
  const peersPageTarget = useAppStore((s) => s.peersPageTarget)
  const setPeersPageTarget = useAppStore((s) => s.setPeersPageTarget)
  const closePeersPage = useAppStore((s) => s.closePeersPage)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  usePeersPageEscape(closePeersPage)

  // Why: keep the shown terminal in sync with what the host is actually sharing —
  // pick a default when none is selected yet, and drop a selection the host revoked.
  useEffect(() => {
    if (clientStatus.state !== 'connected') {
      if (peersPageTarget !== null) {
        setPeersPageTarget(null)
      }
      return
    }
    const stillShared = hostTerminals.some(
      (terminal) => terminal.handle === peersPageTarget?.handle
    )
    if (stillShared) {
      return
    }
    const first = hostTerminals[0]
    const next = first ? { handle: first.handle, title: first.title || first.handle } : null
    if (next?.handle !== peersPageTarget?.handle) {
      setPeersPageTarget(next)
    }
  }, [clientStatus.state, hostTerminals, peersPageTarget, setPeersPageTarget])

  const goToSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'peer-collab', repoId: null })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-[12px] leading-normal font-semibold">
          {peersPageTarget?.title ??
            translate('auto.components.peers.PeersPage.d7f2a9c4b6', 'Remote Terminal')}
        </span>
        <Badge variant="outline" className="text-[11px]">
          {connectionBadgeLabel(clientStatus.state)}
        </Badge>
        {clientStatus.state === 'connected' && clientStatus.endpoint ? (
          <span className="text-xs text-muted-foreground">{clientStatus.endpoint}</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              onClick={closePeersPage}
              aria-label={translate('auto.components.peers.PeersPage.e5b8c1f3a2', 'Close')}
            >
              <XIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate('auto.components.peers.PeersPage.f9a3d6e2b1', 'Close · Esc')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-1 min-h-0">
        {clientStatus.state !== 'connected' ? (
          <PeersEmptyState kind="disconnected" onOpenSettings={goToSettings} />
        ) : hostTerminals.length === 0 ? (
          <PeersEmptyState kind="no-terminals" onOpenSettings={goToSettings} />
        ) : (
          <div className="min-w-0 flex-1">
            {peersPageTarget ? (
              <RemoteTerminalPanel
                key={peersPageTarget.handle}
                terminalHandle={peersPageTarget.handle}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
