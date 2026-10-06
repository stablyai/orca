import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'

// One waiting catalog read per chat, shared by every mount and effect run of that chat's picker:
// a remote read cannot be withdrawn once sent, so a re-run joins the one in flight instead of
// sending another. An entry lives exactly as long as its read.

/** Null when the read failed or timed out. */
export type HostModelListingJoiner = (catalog: AgentSessionModelCatalogResult | null) => void

const waits = new Map<string, Set<HostModelListingJoiner>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Joins the chat's waiting read, started by `read` only when none is in flight. Returns `leave`. */
export function joinHostModelListingWait(
  key: string,
  read: () => Promise<AgentSessionModelCatalogResult>,
  onSettled: HostModelListingJoiner
): () => void {
  let joiners = waits.get(key)
  if (!joiners) {
    const started = new Set<HostModelListingJoiner>()
    joiners = started
    waits.set(key, started)
    const settle = (catalog: AgentSessionModelCatalogResult | null): void => {
      try {
        // Every joiner applies before the hold lifts, so the answer and the release commit together.
        for (const joiner of started) {
          joiner(catalog)
        }
      } finally {
        waits.delete(key)
        notify()
      }
    }
    new Promise<AgentSessionModelCatalogResult>((resolve) => resolve(read())).then(settle, () =>
      settle(null)
    )
    notify()
  }
  joiners.add(onSettled)
  const joined = joiners
  return () => {
    joined.delete(onSettled)
  }
}

export function isHostModelListingWaitInFlight(key: string): boolean {
  return waits.has(key)
}

export function subscribeHostModelListingWaits(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
