import { connect, createServer, type Server, type Socket } from 'node:net'

type SocketPair = { client: Socket; upstream: Socket }

export class SshHalfOpenProxy {
  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly pairs: Set<SocketPair>
  ) {}

  static async start(host: string, port: number): Promise<SshHalfOpenProxy> {
    const pairs = new Set<SocketPair>()
    const server = createServer((client) => {
      const upstream = connect({ host, port })
      const pair = { client, upstream }
      pairs.add(pair)
      client.setNoDelay(true)
      upstream.setNoDelay(true)

      const retire = (): void => {
        if (!pairs.delete(pair)) {
          return
        }
        client.destroy()
        upstream.destroy()
      }
      client.on('error', retire)
      client.on('close', retire)
      upstream.on('error', retire)
      upstream.on('close', retire)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('SSH half-open proxy did not bind a TCP port')
    }
    return new SshHalfOpenProxy(server, address.port, pairs)
  }

  blackholeEstablishedConnections(): number {
    for (const pair of this.pairs) {
      pair.client.unpipe(pair.upstream)
      pair.upstream.unpipe(pair.client)
      pair.client.pause()
      pair.upstream.pause()
    }
    return this.pairs.size
  }

  async close(): Promise<void> {
    for (const pair of this.pairs) {
      pair.client.destroy()
      pair.upstream.destroy()
    }
    this.pairs.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
