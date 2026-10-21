import net from 'node:net'

export type FreezableTcpProxy = {
  port: number
  /** Connection open/close timestamps, for diagnosing client reconnect behaviour. */
  events: string[]
  /** Silently stops forwarding on every open connection while keeping it open, like a NAT drop. */
  freezeExisting: (direction?: 'both' | 'to-client') => number
  /**
   * Takes the whole link down until `restore`. `silent` freezes open connections and holds new ones
   * unanswered, like a sleeping laptop; `reset` closes everything and refuses new connections.
   */
  cut: (mode: 'silent' | 'reset') => void
  /** Ends a `cut`: drops connections that lived through it, as a returning network does, and relays new ones. */
  restore: () => void
  close: () => Promise<void>
}

type ProxyPair = { client: net.Socket; upstream: net.Socket | null; frozen: boolean }

/** A loopback TCP proxy whose established connections can go half-open while new ones still pass. */
export async function startFreezableTcpProxy(
  targetHost: string,
  targetPort: number
): Promise<FreezableTcpProxy> {
  const pairs = new Set<ProxyPair>()
  const events: string[] = []
  let nextId = 0
  let cutMode: 'silent' | 'reset' | null = null
  const destroyPair = (pair: ProxyPair): void => {
    pair.client.destroy()
    pair.upstream?.destroy()
    pairs.delete(pair)
  }
  const server = net.createServer((client) => {
    const id = nextId++
    events.push(`${Date.now()} open#${id}${cutMode ? ` (during ${cutMode} cut)` : ''}`)
    client.on('close', () => events.push(`${Date.now()} close#${id}`))
    client.on('error', () => undefined)
    if (cutMode === 'reset') {
      client.destroy()
      return
    }
    if (cutMode === 'silent') {
      // Why held, not refused: an unreachable host answers nothing; the dial must time out on its own.
      client.pause()
      pairs.add({ client, upstream: null, frozen: true })
      return
    }
    const upstream = net.connect(targetPort, targetHost)
    const pair: ProxyPair = { client, upstream, frozen: false }
    pairs.add(pair)
    client.pipe(upstream)
    upstream.pipe(client)
    const end = (): void => {
      // Why: a frozen pair must not relay a close either; the far side would learn of the drop.
      if (!pair.frozen) {
        destroyPair(pair)
      }
    }
    client.on('close', end)
    upstream.on('close', end)
    upstream.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Proxy did not bind a TCP port')
  }
  const freezeExisting = (direction: 'both' | 'to-client' = 'both'): number => {
    let frozen = 0
    for (const pair of pairs) {
      if (pair.frozen || !pair.upstream) {
        continue
      }
      pair.frozen = true
      // Why one-way: requests still reach the host while its replies and publications vanish.
      pair.upstream.unpipe(pair.client)
      pair.upstream.pause()
      if (direction === 'both') {
        pair.client.unpipe(pair.upstream)
        pair.client.pause()
      }
      frozen += 1
    }
    return frozen
  }
  return {
    port: address.port,
    events,
    freezeExisting,
    cut: (mode) => {
      cutMode = mode
      events.push(`${Date.now()} cut:${mode}`)
      if (mode === 'silent') {
        freezeExisting('both')
        return
      }
      for (const pair of pairs) {
        destroyPair(pair)
      }
    },
    restore: () => {
      cutMode = null
      events.push(`${Date.now()} restore`)
      for (const pair of pairs) {
        if (pair.frozen) {
          destroyPair(pair)
        }
      }
    },
    close: async () => {
      for (const pair of pairs) {
        destroyPair(pair)
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
