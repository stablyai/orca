import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../../file-content/node-bounded-file-reader'
import { writeSecureJsonFile } from '../../../secure-storage/secure-file'
import type { PairedE2EEV2LatchStore } from '../paired-e2ee-framing-policy'

export type NodeE2EEV2HostLatchStore = PairedE2EEV2LatchStore & {
  /** Only after the host itself, over a channel keyed to its pinned key, shows it predates v2 token auth. */
  unlatch: (hostPublicKeyB64: string) => void
}

export const REMOTE_RUNTIME_E2EE_V2_HOSTS_FILENAME = 'remote-runtime-e2ee-v2-hosts.json'
const MAX_LATCHED_HOSTS = 512
const MAX_FILE_BYTES = 64 * 1024
const MAX_HOST_KEY_LENGTH = 128

let configured: { userDataPath: string | null; store: NodeE2EEV2HostLatchStore } | null = null

/** Persist v2-capable hosts in this profile; the desktop app and the CLI share it. */
export function configureRemoteRuntimeE2EEV2HostLatch(userDataPath: string | null): void {
  if (configured?.userDataPath === userDataPath) {
    return
  }
  configured = {
    userDataPath,
    store: createNodeE2EEV2HostLatchStore(
      userDataPath ? join(userDataPath, REMOTE_RUNTIME_E2EE_V2_HOSTS_FILENAME) : null
    )
  }
}

/** Unconfigured processes (tests, tools) keep the latch in memory. */
export function remoteRuntimeE2EEV2HostLatchStore(): NodeE2EEV2HostLatchStore {
  configured ??= { userDataPath: null, store: createNodeE2EEV2HostLatchStore(null) }
  return configured.store
}

/**
 * Hosts (by pinned public key) this profile has authenticated with E2EE v2. Shared by the desktop
 * app and the CLI through the profile directory; a null path keeps the latch in memory only.
 */
export function createNodeE2EEV2HostLatchStore(filePath: string | null): NodeE2EEV2HostLatchStore {
  let latched: Set<string> | null = null
  const load = (): Set<string> => {
    const current = latched ?? new Set<string>()
    for (const key of readLatchedHosts(filePath)) {
      current.add(key)
    }
    latched = current
    return current
  }
  return {
    // Why re-read: the other process (desktop or CLI) may have latched the host since.
    hydrate: async () => {
      load()
    },
    // Why never null: the file read is synchronous, so the answer is always known.
    isLatched: (hostPublicKeyB64) => (latched ?? load()).has(hostPublicKeyB64),
    latch: (hostPublicKeyB64) => {
      const current = latched ?? load()
      if (!hostPublicKeyB64 || current.has(hostPublicKeyB64)) {
        return
      }
      current.add(hostPublicKeyB64)
      persist(filePath, load())
    },
    unlatch: (hostPublicKeyB64) => {
      const current = load()
      if (current.delete(hostPublicKeyB64)) {
        persist(filePath, current)
      }
    }
  }
}

function persist(filePath: string | null, hosts: Set<string>): void {
  if (!filePath) {
    return
  }
  try {
    writeSecureJsonFile(filePath, { version: 1, hosts: [...hosts].slice(-MAX_LATCHED_HOSTS) })
  } catch (error) {
    // The in-memory latch still applies for this process.
    console.warn('[remote-runtime] Could not save the E2EE v2 host list:', error)
  }
}

function readLatchedHosts(filePath: string | null): string[] {
  if (!filePath || !existsSync(filePath)) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(
      readNodeFileSyncWithinLimit(filePath, MAX_FILE_BYTES).buffer.toString('utf8')
    )
    const hosts =
      typeof parsed === 'object' && parsed !== null && 'hosts' in parsed ? parsed.hosts : null
    return Array.isArray(hosts)
      ? hosts.filter(
          (key): key is string =>
            typeof key === 'string' && key.length > 0 && key.length <= MAX_HOST_KEY_LENGTH
        )
      : []
  } catch {
    // Why empty: an unreadable list must not cut off hosts that never spoke v2.
    return []
  }
}
