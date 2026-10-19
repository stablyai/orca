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
          // Why: replay is never re-sent, so it takes the control lane where overflow is fatal — the
          // writer closes the client and reconnect reloads history rather than stranding a short buffer.
          this.enqueuePreparedFrame(client, frame, 'control')
          continue
        }
        // Why: closing can never make an oversized frame sendable — the producer regenerates it after
        // reattach and re-kills the link, turning a recoverable drop into an endless reconnect loop.
        if (!this.publishPreparedToClient(client, frame, 'ordinary')) {
          this.logDroppedProducerNotification(client, method, frame.frameBytes)
        }
      }
    })
  }

  // Why: producer-lane publication for a single client; notifyClient/tryNotifyClient use the control lane,
  // which floods must never occupy. Rejection drops the frame and never closes the client.
  publishProducerNotification(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    // Why: a caller that recovers from rejection itself (the watcher emitter re-sends the batch in
    // chunks) would otherwise log "Dropped" for a frame it goes on to deliver in full.
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
    // Why: same diagnostics as notify() — a producer that drops here must not do so silently.
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

  /**
   * Bulk-lane notification: sends are serialized per client and the promise
   * resolves only after the sink accepted the frame (backpressure), so bulk
   * producers await between frames and never starve interactive frames.
   * With `clientId`, targets only that client — broadcasting would let one slow secondary stall everyone.
   */
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

  // Why: one line per generation, method and drop reason — a flooding producer retries every batch and would
  // spam stderr, but a transient queue-full drop must not consume the slot a real over-capacity drop needs.
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
