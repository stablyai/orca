import { createBrowserUuid } from '@/lib/browser-uuid'
import { LSP_PORT_WINDOW_MESSAGE } from '../../../../shared/language-server-types'
import { LspPortClient } from './lsp-port-client'

const PORT_WAIT_MS = 5_000
const REFUSAL_CACHE_MS = 10_000

type CachedClient = { client: Promise<LspPortClient | null>; refusedAt: number | null }
type PortDeferred = { port: MessagePort | null; resolve: (port: MessagePort) => void }
const clients = new Map<string, CachedClient>()
const leases = new Map<string, number>()
const portWaiters = new Map<string, PortDeferred>()
let listening = false

function ensurePortListener(): void {
  if (listening) {
    return
  }
  listening = true
  window.addEventListener('message', (event) => {
    const data: unknown = event.data
    if (event.source !== window || typeof data !== 'object' || data === null) {
      return
    }
    const requestId =
      'type' in data && data.type === LSP_PORT_WINDOW_MESSAGE && 'requestId' in data
        ? data.requestId
        : null
    const port = event.ports[0]
    if (typeof requestId !== 'string' || !port) {
      return
    }
    const deferred = portWaiters.get(requestId)
    portWaiters.delete(requestId)
    if (deferred) {
      deferred.port = port
      deferred.resolve(port)
    } else {
      port.close()
    }
  })
}

async function openClient(worktreeId: string, languageId: string): Promise<LspPortClient | null> {
  ensurePortListener()
  const requestId = createBrowserUuid()

  // Why: register waiter before open so ports that arrive synchronously are captured.
  // Create a placeholder; listener will populate port and call resolve.
  const deferred: PortDeferred = { port: null, resolve: () => {} }
  portWaiters.set(requestId, deferred)

  const result = await window.api.lsp.open({ requestId, worktreeId, languageId }).catch(() => null)
  if (!result?.ok) {
    portWaiters.delete(requestId)
    // Why: close port if it arrived before open failed, to prevent process leak.
    deferred.port?.close()
    return null
  }

  // If port arrived early (before open resolved), use it immediately
  if (deferred.port !== null) {
    return new LspPortClient(deferred.port)
  }

  // Otherwise wait for port with timeout
  let timerHandle: ReturnType<typeof setTimeout> | null = null
  const portWithTimeout = new Promise<MessagePort | null>((resolve) => {
    // Update the resolve function to include timer cleanup
    deferred.resolve = (p) => {
      if (timerHandle !== null) {
        clearTimeout(timerHandle)
      }
      resolve(p)
    }
    timerHandle = setTimeout(() => {
      if (portWaiters.delete(requestId)) {
        resolve(null)
      }
    }, PORT_WAIT_MS)
  })

  const received = await portWithTimeout
  return received ? new LspPortClient(received) : null
}

/** Cached per worktree + Monaco language; a refusal is cached briefly so hovers don't hammer IPC. */
function clientKey(worktreeId: string, languageId: string): string {
  return `${worktreeId}\u0000${languageId}`
}

export async function getLspClient(
  worktreeId: string,
  languageId: string
): Promise<LspPortClient | null> {
  const key = clientKey(worktreeId, languageId)

  while (true) {
    const cached = clients.get(key)
    if (cached) {
      const client = await cached.client
      // Check if the cache entry was replaced by a concurrent call while we awaited.
      if (clients.get(key) !== cached) {
        continue
      }
      if (client && !client.isClosed) {
        return client
      }
      if (
        !client &&
        cached.refusedAt !== null &&
        Date.now() - cached.refusedAt < REFUSAL_CACHE_MS
      ) {
        return null
      }
    }

    const entry: CachedClient = { client: Promise.resolve(null), refusedAt: null }
    // Why: set refusedAt inside the chain so concurrent awaiters never see a half-updated entry.
    entry.client = openClient(worktreeId, languageId).then((client) => {
      entry.refusedAt = client ? null : Date.now()
      return client
    })
    clients.set(key, entry)
    return entry.client
  }
}

/** Marks a user (a tracked document or an in-flight lookup) of the worktree + language client. */
export function retainLspClient(worktreeId: string, languageId: string): void {
  const key = clientKey(worktreeId, languageId)
  leases.set(key, (leases.get(key) ?? 0) + 1)
}

/** Drops one user; the last one closes the port so main can idle the server out. */
export function releaseLspClient(worktreeId: string, languageId: string): void {
  const key = clientKey(worktreeId, languageId)
  const remaining = (leases.get(key) ?? 0) - 1
  if (remaining > 0) {
    leases.set(key, remaining)
    return
  }
  leases.delete(key)
  const entry = clients.get(key)
  clients.delete(key)
  void entry?.client.then((client) => client?.close())
}

export function resetLspClients(): void {
  for (const entry of clients.values()) {
    void entry.client.then((client) => client?.close())
  }
  clients.clear()
}
