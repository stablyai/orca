import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'

export type PeersFlatTab = {
  hostId: string
  handle: string
  title: string
  hostLabel: string
  /** First tab of its host in the flat list — the tab strip renders a separator/label before it. */
  isFirstOfHost: boolean
}

export function peersFlatTabKey(tab: Pick<PeersFlatTab, 'hostId' | 'handle'>): string {
  return `${tab.hostId}:${tab.handle}`
}

/** Every terminal across every connected host, in host order then terminal order — the row the tab strip and keyboard shortcuts operate on. */
export function buildPeersFlatTabs(hosts: PeerHostConnection[]): PeersFlatTab[] {
  return hosts
    .filter((host) => host.status.state === 'connected')
    .flatMap((host) =>
      host.terminals.map((terminal, index) => ({
        hostId: host.hostId,
        handle: terminal.handle,
        title: terminal.title ?? '',
        hostLabel: host.endpoint || host.hostId,
        isFirstOfHost: index === 0
      }))
    )
}

export function resolvePeersTabByIndex(
  tabs: readonly PeersFlatTab[],
  index: number
): PeersFlatTab | null {
  return tabs[index] ?? null
}

/** Steps `direction` tabs from `activeKey`, wrapping around both ends; defaults to the first tab when nothing is active or the active tab dropped out of the list. */
export function resolveAdjacentPeersTab(
  tabs: readonly PeersFlatTab[],
  activeKey: string | null,
  direction: 1 | -1
): PeersFlatTab | null {
  if (tabs.length === 0) {
    return null
  }
  const currentIndex = activeKey ? tabs.findIndex((tab) => peersFlatTabKey(tab) === activeKey) : -1
  if (currentIndex === -1) {
    return tabs[0]
  }
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
  return tabs[nextIndex]
}

/** Reorders tabs by the user's saved handle order; handles missing from the
 *  saved order (new terminals) keep their natural position at the end. */
export function applyPeersTabOrder(
  tabs: readonly PeersFlatTab[],
  order: readonly string[] | undefined
): PeersFlatTab[] {
  if (!order || order.length === 0) {
    return [...tabs]
  }
  const rank = new Map(order.map((handle, index) => [handle, index]))
  return [...tabs].sort((a, b) => {
    const ra = rank.get(a.handle)
    const rb = rank.get(b.handle)
    if (ra === undefined && rb === undefined) {
      return 0
    }
    if (ra === undefined) {
      return 1
    }
    if (rb === undefined) {
      return -1
    }
    return ra - rb
  })
}
