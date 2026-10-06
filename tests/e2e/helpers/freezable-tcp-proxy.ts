import net from 'node:net'

export type FreezableTcpProxy = {
  port: number
  /** Connection open/close timestamps, for diagnosing client reconnect behaviour. */
  events: string[]
  /** Silently stops forwarding on every open connection while keeping it open, like a NAT drop. */
  freezeExisting: (direction?: 'both' | 'to-client') => number
  /** Refuses new connections while true, like a network that is still down. */
  refuseNew: (refuse: boolean) => void
  close: () => Promise<void>
}

/** A loopback TCP proxy whose established connections can go half-open while new ones still pass. */
export async function startFreezableTcpProxy(
  targetHost: string,
  targetPort: number
): Promise<FreezableTcpProxy> {
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket; frozen: boolean }>()
  const events: string[] = []
  let nextId = 0
  let refusing = false
  const server = net.createServer((client) => {
    const id = nextId++
    if (refusing) {
      events.push(`${Date.now()} refused#${id}`)
      client.destroy()
      return
    }
    events.push(`${Date.now()} open#${id}`)
    client.on('close', () => events.push(`${Date.now()} close#${id}`))
    const upstream = net.connect(targetPort, targetHost)
    const pair = { client, upstream, frozen: false }
    pairs.add(pair)
    client.pipe(upstream)
    upstream.pipe(client)
    const end = (): void => {
      // Why: a frozen pair must not relay a close either; the far side would learn of the drop.
      if (!pair.frozen) {
        client.destroy()
        upstream.destroy()
        pairs.delete(pair)
      }
    }
    client.on('close', end)
    upstream.on('close', end)
    client.on('error', () => undefined)
    upstream.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Proxy did not bind a TCP port')
  }
  return {
    port: address.port,
    events,
    freezeExisting: (direction = 'both') => {
      let frozen = 0
      for (const pair of pairs) {
        if (pair.frozen) {
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
    },
    refuseNew: (refuse) => {
      refusing = refuse
    },
    close: async () => {
      for (const pair of pairs) {
        pair.client.destroy()
        pair.upstream.destroy()
      }
      pairs.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
