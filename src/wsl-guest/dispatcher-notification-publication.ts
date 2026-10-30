import type { SinkWriteSettlement } from './dispatcher-client-writer'
import type { JsonRpcNotification } from './protocol'
import {
  DROPPED_NOTIFICATION_LOG_KEY_LIMIT,
  type PreparedRelayFrame,
  type RelayClient
} from './dispatcher-contract'
import { RelayDispatcherPtyPublication } from './dispatcher-pty-publication'

export abstract class RelayDispatcherNotificationPublication extends RelayDispatcherPtyPublication {
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    this.runPublicationTransaction(() => {
      let frame: PreparedRelayFrame | undefined
      for (const client of this.clients.values()) {
        if (client.closed) {
          continue
        }
        if (method === 'pty.data' && !this.admitsPtyDataPublication(client.id, params ?? {})) {
          continue
        }
        frame ??= this.prepareFrame(msg)
        if (method === 'pty.replay') {
          // Replay overflow stays fatal: reconnect reloads history, whereas silent loss strands a short buffer.
          this.enqueuePreparedFrame(client, frame, 'control')
          continue
        }
        // Do not close on oversized producer frames; regenerating the same frame after reattach causes a reconnect loop.
        if (!this.publishPreparedToClient(client, frame, 'ordinary')) {
          this.logDroppedProducerNotification(client, method, frame.frameBytes)
        }
      }
    })
  }

  // Use the producer lane for best-effort frames; rejection drops them without closing the client.
  publishProducerNotification(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    // Let self-recovering callers suppress drop logs when they will split and deliver the full batch.
    options?: { logDrop?: boolean }
  ): boolean {
    if (this.disposed) {
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      return false
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    if (method === 'pty.data' && !this.admitsPtyDataPublication(client.id, params ?? {})) {
      return false
    }
    const frame = this.prepareFrame(msg)
    if (this.publishPreparedToClient(client, frame, 'ordinary')) {
      return true
    }
    if (options?.logDrop !== false) {
      this.logDroppedProducerNotification(client, method, frame.frameBytes)
    }
    return false
  }

  notifyClient(clientId: number, method: string, params?: Record<string, unknown>): void {
    this.tryNotifyClient(clientId, method, params)
  }

  tryNotifyClient(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    options: {
      controlOverflow?: 'close-client' | 'reject'
    } = {}
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    return this.enqueueFrame(
      client,
      {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {})
      },
      'control',
      onSettled,
      options.controlOverflow
    )
  }

  notifyControl(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    const clients = this.activeClients()
    if (clients.length === 0) {
      return
    }
    const frame = this.prepareFrame(msg)
    for (const client of clients) {
      if (!this.enqueuePreparedFrame(client, frame, 'control')) {
        this.closeClient(
          client,
          new Error('Relay control publication capacity exceeded'),
          client !== this.primaryClient
        )
      }
    }
  }

  // Serialize bulk sends per client and await sink admission so producers cannot starve interactive traffic.
  // Target clientId explicitly when one slow secondary must not block healthy clients.
  notifyBulk(
    method: string,
    params?: Record<string, unknown>,
    opts?: { clientId?: number }
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const targets =
      opts?.clientId !== undefined
        ? [this.clients.get(opts.clientId)].filter((c): c is RelayClient => c !== undefined)
        : Array.from(this.clients.values())
    const activeTargets = targets.filter((client) => !client.closed)
    if (activeTargets.length === 0) {
      return Promise.resolve()
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params: { ...params } } : {})
    }
    let prepared:
      | { ok: true; frame: PreparedRelayFrame }
      | { ok: false; error: unknown }
      | undefined
    const prepareOnce = (): PreparedRelayFrame => {
      if (!prepared) {
        try {
          prepared = { ok: true, frame: this.prepareFrame(msg) }
        } catch (error) {
          prepared = { ok: false, error }
        }
      }
      if (!prepared.ok) {
        throw prepared.error
      }
      return prepared.frame
    }
    const lane = method === 'fs.streamChunk' ? 'fixed-bulk' : 'bulk'
    const waits: Promise<void>[] = []
    for (const client of activeTargets) {
      const step = client.bulkChain.then(() => {
        if (this.disposed || client.closed) {
          return
        }
        return this.publishBulkWhenAvailable(client, prepareOnce(), lane)
      })
      client.bulkChain = step.catch(() => {})
      waits.push(step)
    }
    return Promise.all(waits).then(() => {})
  }

  // Log once per generation/method/reason; queue-full retries must not suppress a later over-capacity diagnostic.
  private logDroppedProducerNotification(client: RelayClient, method: string, bytes: number): void {
    const capacity = client.writer.producerFrameCapacity
    const overCapacity = bytes > capacity
    const key = `${method}:${overCapacity ? 'over-capacity' : 'queue-full'}`
    let log = client.droppedNotificationLog
    if (!log || log.generation !== client.generation) {
      log = { generation: client.generation, loggedKeys: new Set() }
      client.droppedNotificationLog = log
    }
    if (log.loggedKeys.has(key) || log.loggedKeys.size >= DROPPED_NOTIFICATION_LOG_KEY_LIMIT) {
      return
    }
    log.loggedKeys.add(key)
    process.stderr.write(
      overCapacity
        ? `[relay] Dropped ${method} (${bytes}B > producer frame capacity ${capacity}B)\n`
        : `[relay] Dropped ${method} (${bytes}B, producer queue full; frame capacity ${capacity}B)\n`
    )
  }
}
