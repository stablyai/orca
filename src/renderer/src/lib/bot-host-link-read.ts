// Whether each host's link to Orca Cloud (its bots.list connectorStatus) was read lately, and whether that
// read landed, so a surface that must not act on a kept status can wait for one read sent after it opened.
// Also each host's comings-back: a read sent before a host went away answers for a host that may have
// changed since, so it says nothing once the host is back.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

/** One bots.list read: its place in send order, and the host's coming-back it was sent in. */
export type BotHostLinkReadTicket = { sent: number; generation: number }

let lastSent = 0
const reads = new Map<ExecutionHostId, { sent: number; ok: boolean }>()
const generations = new Map<ExecutionHostId, number>()
const listeners = new Set<() => void>()
const cameBackListeners = new Set<(hostId: ExecutionHostId) => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  listeners.forEach((listener) => listener())
}

/** How many times the host has come back; a read sent before the latest says nothing of it now. */
export function botHostGeneration(hostId: ExecutionHostId): number {
  return generations.get(hostId) ?? 0
}

/** The host's comings-back, re-read when it comes back, so a view can retry what failed while it was away. */
export function useBotHostGeneration(hostId: ExecutionHostId): number {
  const read = (): number => botHostGeneration(hostId)
  return useSyncExternalStore(subscribe, read, read)
}

/** A bots.list read is being sent; its ticket goes to noteBotHostLinkRead once it lands or fails. */
export function sendBotHostLinkRead(hostId: ExecutionHostId): BotHostLinkReadTicket {
  lastSent += 1
  return { sent: lastSent, generation: botHostGeneration(hostId) }
}

/** Whether a read sent with `ticket` still answers for the host: it hasn't come back since. */
export function botHostLinkReadCurrent(
  hostId: ExecutionHostId,
  ticket: BotHostLinkReadTicket
): boolean {
  return ticket.generation === botHostGeneration(hostId)
}

/** The newest read number sent so far, on any host: a later read is one sent after now. */
export function botHostLinkReadMark(): number {
  return lastSent
}

/** The host's bots.list read landed (ok) or failed; a failed read leaves its kept status unproven. */
export function noteBotHostLinkRead(
  hostId: ExecutionHostId,
  ok: boolean,
  ticket: BotHostLinkReadTicket
): void {
  if (!botHostLinkReadCurrent(hostId, ticket)) {
    return
  }
  reads.set(hostId, { sent: ticket.sent, ok })
  notify()
}

/**
 * The host is about to show as back: its new coming-back is counted before any view can act on it, so
 * a read sent as the listing publishes it belongs to this return, not to before it went away. The
 * caller then tells everyone through noteBotHostCameBack(hostId, true).
 */
export function advanceBotHostGeneration(hostId: ExecutionHostId): void {
  generations.set(hostId, botHostGeneration(hostId) + 1)
  reads.delete(hostId)
}

/**
 * The host came back: what it said before it went away proves nothing about it now, including reads
 * still out from before. Its account reads follow this too (onBotHostCameBack).
 */
export function noteBotHostCameBack(hostId: ExecutionHostId, advanced = false): void {
  if (!advanced) {
    advanceBotHostGeneration(hostId)
  }
  notify()
  cameBackListeners.forEach((listener) => listener(hostId))
}

export function onBotHostCameBack(listener: (hostId: ExecutionHostId) => void): () => void {
  cameBackListeners.add(listener)
  return () => cameBackListeners.delete(listener)
}

/** Whether the host's last read was sent after `mark` (botHostLinkReadMark) and landed. */
export function botHostLinkReadSince(hostId: ExecutionHostId, mark: number): boolean {
  const last = reads.get(hostId)
  return last !== undefined && last.ok && last.sent > mark
}

/**
 * Whether the host's link to Orca Cloud has been read since this view opened, or since `since` last
 * changed (this computer's sign-in, say), and that read and every later one landed. Each start reads
 * again through `refresh` (bot-host-refresh.ts's, passed in to keep this module free of the catalog).
 * `mark` is where that count starts, for an action that must use the same threshold.
 */
export function useBotHostLinkReadSinceOpen(
  hostId: ExecutionHostId,
  refresh: (hostId: ExecutionHostId) => Promise<void>,
  since?: string
): { fresh: boolean; mark: number } {
  const [opened, setOpened] = useState(() => ({ hostId, since, mark: botHostLinkReadMark() }))
  let current = opened
  if (opened.hostId !== hostId || opened.since !== since) {
    // Adjusting state while rendering, as React documents for a value that follows a prop.
    current = { hostId, since, mark: botHostLinkReadMark() }
    setOpened(current)
  }
  const read = (): boolean => botHostLinkReadSince(hostId, current.mark)
  const fresh = useSyncExternalStore(subscribe, read, read)
  useEffect(() => {
    void refresh(hostId)
  }, [hostId, refresh, since])
  return { fresh, mark: current.mark }
}
