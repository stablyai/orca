// Why: deterministic per-clientId assignment so every participant sees the same
// color for the same peer without a color-picker UI.
const PEER_PRESENCE_COLORS = [
  '#f97316',
  '#22c55e',
  '#3b82f6',
  '#ec4899',
  '#eab308',
  '#14b8a6',
  '#a855f7',
  '#ef4444'
] as const

export function assignPeerPresenceColor(clientId: string): string {
  let hash = 0
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0
  }
  return PEER_PRESENCE_COLORS[hash % PEER_PRESENCE_COLORS.length]!
}
