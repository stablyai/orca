import { useCallback, useEffect, useMemo } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PeerClientStatus } from '../../../../shared/peer-client-status'
import {
  usePeerCollabClientConnection,
  type PeerHostConnection
} from '@/components/peer-collab/use-peer-collab-client-connection'
import { PeersEmptyState } from './PeersEmptyState'
import { PeersPageTabStrip } from './PeersPageTabStrip'
import { PeersPanels } from './PeersPanels'
import { usePeersPageEscape } from './use-peers-page-escape'
import {
  applyPeersTabOrder,
  buildPeersFlatTabs,
  peersFlatTabKey,
  type PeersFlatTab
} from './peers-flat-tab-list'

function connectionBadgeLabel(state: PeerClientStatus['state']): string {
  if (state === 'connected') {
    return translate('auto.components.peers.PeersPage.a4c1e8f0b7', 'Connected')
  }
  if (state === 'reconnect-wait' || state === 'connecting') {
    return translate('auto.components.peers.PeersPage.b8d3a6c2e9', 'Reconnecting')
  }
  return translate('auto.components.peers.PeersPage.c2e9f5a1d8', 'Disconnected')
}

function isTargetStillGranted(
  hosts: PeerHostConnection[],
  hostId: string | undefined,
  handle: string | undefined
): boolean {
  const host = hosts.find((h) => h.hostId === hostId && h.status.state === 'connected')
  return Boolean(host?.terminals.some((terminal) => terminal.handle === handle))
}

// Why: the current tab's terminal may have been revoked or its host disconnected —
// prefer another terminal on the same host, then the first terminal on any other
// connected host, so the selection follows the grant rather than going stale.
function resolveFallbackTarget(
  hosts: PeerHostConnection[],
  currentHostId: string | undefined
): { hostId: string; handle: string; title: string } | null {
  const ordered = [
    ...hosts.filter((host) => host.hostId === currentHostId),
    ...hosts.filter((host) => host.hostId !== currentHostId)
  ]
  for (const host of ordered) {
    if (host.status.state !== 'connected') {
      continue
    }
    const [first] = host.terminals
    if (first) {
      return { hostId: host.hostId, handle: first.handle, title: first.title ?? '' }
    }
  }
  return null
}

export default function PeersPage(): React.JSX.Element {
  const { hosts } = usePeerCollabClientConnection()
  const peersPageTarget = useAppStore((s) => s.peersPageTarget)
  const setPeersPageTarget = useAppStore((s) => s.setPeersPageTarget)
  const closePeersPage = useAppStore((s) => s.closePeersPage)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  usePeersPageEscape(closePeersPage)

  const anyConnected = hosts.some((host) => host.status.state === 'connected')

  // Why: keep the shown terminal in sync with what hosts are actually granting —
  // pick a default when none is selected yet, and follow the grant/host away when it's revoked.
  useEffect(() => {
    if (!anyConnected) {
      if (peersPageTarget !== null) {
        setPeersPageTarget(null)
      }
      return
    }
    if (isTargetStillGranted(hosts, peersPageTarget?.hostId, peersPageTarget?.handle)) {
      return
    }
    const fallback = resolveFallbackTarget(hosts, peersPageTarget?.hostId)
    if (
      fallback?.handle !== peersPageTarget?.handle ||
      fallback?.hostId !== peersPageTarget?.hostId
    ) {
      setPeersPageTarget(fallback)
    }
  }, [anyConnected, hosts, peersPageTarget, setPeersPageTarget])

  const goToSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'peer-collab', repoId: null })
  }

  const selectedHost = hosts.find((host) => host.hostId === peersPageTarget?.hostId)
  const selectedHostConnected = selectedHost?.status.state === 'connected'
  const badgeState: PeerClientStatus['state'] = selectedHost?.status.state ?? 'closed'

  const peersTabOrderByHost = useAppStore((s) => s.peersTabOrderByHost)
  const setPeersTabOrderForHost = useAppStore((s) => s.setPeersTabOrderForHost)

  // Why: tabs are scoped to the selected host — host switching lives in the
  // sidebar, so the strip only lists that host's sessions.
  const flatTabs = useMemo(
    () =>
      selectedHostConnected && selectedHost
        ? applyPeersTabOrder(
            buildPeersFlatTabs([selectedHost]),
            peersTabOrderByHost[selectedHost.hostId]
          )
        : [],
    [selectedHost, selectedHostConnected, peersTabOrderByHost]
  )

  const selectPeersTab = useCallback(
    (tab: PeersFlatTab) =>
      setPeersPageTarget({ hostId: tab.hostId, handle: tab.handle, title: tab.title }),
    [setPeersPageTarget]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-[12px] leading-normal font-semibold">
          {peersPageTarget
            ? peersPageTarget.title ||
              translate('auto.components.peers.PeersPage.untitledTerminal', 'Untitled terminal')
            : translate('auto.components.peers.PeersPage.d7f2a9c4b6', 'Remote Terminal')}
        </span>
        <Badge variant="outline" className="text-[11px]">
          {connectionBadgeLabel(badgeState)}
        </Badge>
        {selectedHostConnected && selectedHost ? (
          <span className="truncate text-xs text-muted-foreground">
            {selectedHost.name || selectedHost.endpoint}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
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
      </div>
      {selectedHostConnected && peersPageTarget ? (
        <PeersPageTabStrip
          tabs={flatTabs}
          activeKey={peersFlatTabKey(peersPageTarget)}
          onSelect={selectPeersTab}
          onReorder={(handles) => {
            if (selectedHost) {
              setPeersTabOrderForHost(selectedHost.hostId, handles)
            }
          }}
        />
      ) : null}
      <div className="flex flex-1 min-h-0">
        {!anyConnected ? (
          <PeersEmptyState kind="disconnected" onOpenSettings={goToSettings} />
        ) : !peersPageTarget || !selectedHostConnected ? (
          <PeersEmptyState kind="no-terminals" onOpenSettings={goToSettings} />
        ) : (
          <PeersPanels hosts={hosts} primary={peersPageTarget} />
        )}
      </div>
    </div>
  )
}
