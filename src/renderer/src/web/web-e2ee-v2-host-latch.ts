import {
  createPairedE2EEFramingPolicy,
  type PairedE2EEFramingPolicy,
  type PairedE2EEV2LatchStore
} from '../../../shared/remote-runtime/e2ee/paired-e2ee-framing-policy'

// Hosts (by pinned public key) that took capability-carrying v2 token auth from this browser.
const STORAGE_KEY = 'orca.web.e2eeV2Hosts.v1'
const MAX_LATCHED_HOSTS = 128

function readLatchedHosts(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string' && key.length > 0)
      : []
  } catch {
    // Why empty: unreadable storage must not cut off hosts that never spoke v2.
    return []
  }
}

let latched: Set<string> | null = null

const webLatchStore: PairedE2EEV2LatchStore = {
  // Why re-read: another tab may have latched the host since.
  hydrate: async () => {
    latched = new Set([...(latched ?? []), ...readLatchedHosts()])
  },
  isLatched: (hostPublicKeyB64) => (latched ??= new Set(readLatchedHosts())).has(hostPublicKeyB64),
  latch: (hostPublicKeyB64) => {
    const current = (latched ??= new Set(readLatchedHosts()))
    if (!hostPublicKeyB64 || current.has(hostPublicKeyB64)) {
      return
    }
    current.add(hostPublicKeyB64)
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([...new Set([...readLatchedHosts(), ...current])].slice(-MAX_LATCHED_HOSTS))
      )
    } catch {
      // The in-memory latch still applies for this page.
    }
  }
}

const policies = new Map<string, PairedE2EEFramingPolicy>()

/** One policy per host for the page, so every socket shares what a refused v2 dial taught. */
export function webE2EEFramingPolicy(hostPublicKeyB64: string): PairedE2EEFramingPolicy {
  let policy = policies.get(hostPublicKeyB64)
  if (!policy) {
    policy = createPairedE2EEFramingPolicy(hostPublicKeyB64, webLatchStore)
    policies.set(hostPublicKeyB64, policy)
  }
  return policy
}

export function isWebHostLatchedToE2EEV2(hostPublicKeyB64: string): boolean {
  return webLatchStore.isLatched(hostPublicKeyB64) === true
}

/** Only after the host itself, over a channel keyed to its pinned key, shows it predates v2 token auth. */
export function unlatchWebHostFromE2EEV2(hostPublicKeyB64: string): void {
  latched = new Set([...(latched ?? []), ...readLatchedHosts()])
  latched.delete(hostPublicKeyB64)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...latched]))
  } catch {
    // The in-memory change still applies for this page.
  }
}

export function resetWebE2EEV2HostLatchForTests(): void {
  latched = null
  policies.clear()
}
