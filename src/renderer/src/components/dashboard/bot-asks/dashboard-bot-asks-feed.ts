// Every bot's Needs you items, as the main window last read them, for the pop-out's snapshot.
import type { DashboardBotAsk } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

const asksByBot = new Map<string, DashboardBotAsk[]>()
const listeners = new Set<() => void>()
let flattened: DashboardBotAsk[] = []

function announce(): void {
  flattened = [...asksByBot.values()].flat()
  for (const listener of listeners) {
    listener()
  }
}

/** Announces only a real change: the minute tick re-derives the same asks as new arrays. */
export function setDashboardBotAsks(botKey: string, asks: DashboardBotAsk[]): void {
  const previous = asksByBot.get(botKey)
  if (previous ? JSON.stringify(previous) === JSON.stringify(asks) : asks.length === 0) {
    return
  }
  if (asks.length === 0) {
    asksByBot.delete(botKey)
  } else {
    asksByBot.set(botKey, asks)
  }
  announce()
}

export function clearDashboardBotAsks(botKey: string): void {
  if (asksByBot.delete(botKey)) {
    announce()
  }
}

export function readDashboardBotAsks(): DashboardBotAsk[] {
  return flattened
}

export function subscribeToDashboardBotAsks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
