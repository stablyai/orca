import type { AgentSessionModelCatalogResult } from './agent-session-wire'

// One waiting catalog read per chat, shared by every mount and effect run of that chat's picker:
// a remote read cannot be withdrawn once sent, so a re-run joins the one in flight instead of
// sending another. Bounded replies follow accepted work while a picker remains interested.

/** Null when the read failed or timed out. */
export type HostModelListingJoiner = (catalog: AgentSessionModelCatalogResult | null) => void

type ListingWait = {
  joiners: Set<HostModelListingJoiner>
  continuation: ReturnType<typeof setTimeout> | null
}
type HostModelListingTransport = { close: () => void }
const waits = new Map<string, ListingWait>()
const ownerWaits = new WeakMap<HostModelListingTransport, Map<string, ListingWait>>()

function listingWaits(owner?: HostModelListingTransport): Map<string, ListingWait> {
  if (!owner) {
    return waits
  }
  let owned = ownerWaits.get(owner)
  if (!owned) {
    owned = new Map()
    ownerWaits.set(owner, owned)
  }
  return owned
}

/** Joins the chat's waiting read, started by `read` only when none is in flight. Returns `leave`. */
export function joinHostModelListingWait(
  key: string,
  read: () => Promise<AgentSessionModelCatalogResult>,
  onSettled: HostModelListingJoiner,
  owner?: HostModelListingTransport
): () => void {
  const waits = listingWaits(owner)
  let wait = waits.get(key)
  if (!wait) {
    const started: ListingWait = { joiners: new Set(), continuation: null }
    wait = started
    waits.set(key, started)
    const settle = (catalog: AgentSessionModelCatalogResult | null): void => {
      try {
        for (const joiner of started.joiners) {
          joiner(catalog)
        }
      } finally {
        if (catalog?.listingInProgress && started.joiners.size > 0) {
          // A fast host reply must not turn a queued listing into a request spin.
          started.continuation = setTimeout(run, 1_000)
        } else {
          waits.delete(key)
        }
      }
    }
    const run = (): void => {
      started.continuation = null
      new Promise<AgentSessionModelCatalogResult>((resolve) => resolve(read())).then(settle, () =>
        settle(null)
      )
    }
    run()
  }
  wait.joiners.add(onSettled)
  const joined = wait
  return () => {
    joined.joiners.delete(onSettled)
    if (joined.joiners.size === 0 && joined.continuation !== null) {
      clearTimeout(joined.continuation)
      waits.delete(key)
    }
  }
}

export function isHostModelListingWaitInFlight(
  key: string,
  owner?: HostModelListingTransport
): boolean {
  return listingWaits(owner).has(key)
}
