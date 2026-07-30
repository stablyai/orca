// Why: presence is a fan-out layer separate from terminal I/O —
// cursor/scroll/selection/participant state the host relays to every other subscriber of a terminal.
export type PeerPresenceParticipant = {
  clientId: string
  name: string
  color: string
}

export type PeerPresenceCursor = { col: number; row: number } | null

export type PeerPresenceSelection = {
  startCol: number
  startRow: number
  endCol: number
  endRow: number
} | null

export type PeerPresenceScroll = {
  atBottom: boolean
  scrollTop: number
}

export type PeerPresenceState = {
  participant: PeerPresenceParticipant
  cursor: PeerPresenceCursor
  selection: PeerPresenceSelection
  scroll: PeerPresenceScroll
}

export type PeerPresenceEvent =
  | { type: 'ready'; subscriptionId: string }
  | { type: 'state'; terminal: string; state: PeerPresenceState }
  | { type: 'left'; terminal: string; clientId: string }
  | { type: 'end' }
