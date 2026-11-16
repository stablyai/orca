import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { BackendPortRpc, type BackendPort } from './backend-port-rpc'

const connections: BackendPortRpc[] = []
const ports: MessagePort[] = []
function adapt(port: MessagePort): BackendPort {
  ports.push(port)
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      port.on('message', listener)
      return () => {
        port.off('message', listener)
      }
    },
    onClose(listener) {
      port.on('close', listener)
      return () => {
        port.off('close', listener)
      }
    },
    close: () => port.close()
  }
}
function pair(invoke: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>) {
  const channel = new MessageChannel()
  const server = new BackendPortRpc(adapt(channel.port1), 'backend-1', invoke)
  const client = new BackendPortRpc(adapt(channel.port2), 'renderer-1', async () => null)
  connections.push(server, client)
  return { client, server }
}
afterEach(() => {
  connections.splice(0).forEach((connection) => connection.close())
  ports.splice(0).forEach((port) => port.close())
})
it('transfers a report directly and rejects outstanding calls on document disconnect', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<unknown>()
  const { client, server } = pair(async (method, params, signal) => {
    if (method === 'snapshot') {
      return { summary: { inputTokens: 123 }, selection: params }
    }
    started.resolve(signal)
    return release.promise
  })
  await expect(client.call('snapshot', { range: '30d' })).resolves.toEqual({
    summary: { inputTokens: 123 },
    selection: { range: '30d' }
  })
  const pending = client.call('refresh')
  const rejected = expect(pending).rejects.toThrow()
  const signal = await started.promise
  server.close()
  await rejected
  expect(signal.aborted).toBe(true)
  release.resolve(null)
})
it('disconnects when a peer acknowledges a still-running request', async () => {
  const channel = new MessageChannel()
  const pending = Promise.withResolvers<unknown>()
  const invoked = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const invoke = async () => {
    invoked.resolve()
    return pending.promise
  }
  connections.push(
    new BackendPortRpc(adapt(channel.port1), 'backend-1', invoke, () => disconnected.resolve())
  )
  ports.push(channel.port2)
  channel.port2.postMessage({ id: '1', method: 'refresh' })
  await invoked.promise
  channel.port2.postMessage({ ack: '1' })
  await disconnected.promise
  pending.resolve(null)
})
