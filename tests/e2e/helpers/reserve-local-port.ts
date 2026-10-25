import { createServer } from 'node:net'

export type ReservedLocalPort = {
  port: number
  release: () => Promise<void>
}

export async function reserveLocalPort(): Promise<ReservedLocalPort> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to reserve a local port')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) {
        return
      }
      released = true
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
