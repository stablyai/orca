import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
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
it('bounds pending requests and admits the next request after consumption', async () => {
  {
    const release = Promise.withResolvers<void>()
    const { client, server } = pair(async () => {
      await release.promise
      return { inputTokens: 123 }
    })
    const calls = Array.from({ length: 32 }, () => client.call('snapshot'))
    await expect(client.call('snapshot')).rejects.toThrow()
    release.resolve()
    expect(await Promise.all(calls)).toEqual(
      Array.from({ length: 32 }, () => ({ inputTokens: 123 }))
    )
    await expect(client.call('snapshot')).resolves.toEqual({ inputTokens: 123 })
    client.close()
    server.close()
  }
})
it('does not let an early acknowledgement bypass the in-flight request bound', async () => {
  const channel = new MessageChannel()
  const pending = Promise.withResolvers<unknown>()
  const invoked = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const invoke = vi.fn(async () => {
    invoked.resolve()
    return pending.promise
  })
  connections.push(
    new BackendPortRpc(adapt(channel.port1), 'backend-1', invoke, () => disconnected.resolve())
  )
  ports.push(channel.port2)
  channel.port2.postMessage({ id: '1', method: 'refresh' })
  await invoked.promise
  channel.port2.postMessage({ ack: '1' })
  await disconnected.promise
  expect(invoke).toHaveBeenCalledTimes(1)
  pending.resolve(null)
})
