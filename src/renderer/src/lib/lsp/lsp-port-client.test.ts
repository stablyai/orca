import { afterEach, describe, expect, it } from 'vitest'
import { LspPortClient } from './lsp-port-client'

const channels: MessageChannel[] = []
function connectedClient(timeoutMs = 1000) {
  const channel = new MessageChannel()
  channels.push(channel)
  const client = new LspPortClient(channel.port1, timeoutMs)
  channel.port2.start()
  return { client, server: channel.port2 }
}
afterEach(() => channels.splice(0).forEach((c) => (c.port1.close(), c.port2.close())))

describe('LspPortClient', () => {
  it('resolves a request with the matching response', async () => {
    const { client, server } = connectedClient()
    server.addEventListener('message', (event) =>
      server.postMessage({ jsonrpc: '2.0', id: event.data.id, result: 'ok' })
    )
    await expect(client.request('textDocument/hover', {})).resolves.toBe('ok')
  })

  it('rejects on an error response', async () => {
    const { client, server } = connectedClient()
    server.addEventListener('message', (event) =>
      server.postMessage({
        jsonrpc: '2.0',
        id: event.data.id,
        error: { code: -32601, message: 'nope' }
      })
    )
    await expect(client.request('x', {})).rejects.toThrow('nope')
  })

  it('times out and rejects everything after close', async () => {
    const { client } = connectedClient(20)
    await expect(client.request('x', {})).rejects.toThrow('timed out')
    client.close()
    expect(client.isClosed).toBe(true)
    await expect(client.request('x', {})).rejects.toThrow('closed')
  })
})
