import {
  DispatcherClientWriter,
  type RelayClientSinkOptions,
  type RelayClientWrite
} from './dispatcher-client-writer'
import type { RelayClient } from './dispatcher-contract'
import { RelayDispatcherClientLifecycle } from './dispatcher-client-lifecycle'

export abstract class RelayDispatcherCapacitySignals extends RelayDispatcherClientLifecycle {
  onLegacyPtyCapacity(listener: () => void): () => void {
    this.legacyCapacityListeners.add(listener)
    return () => this.legacyCapacityListeners.delete(listener)
  }

  // Watch ungated per-client capacity after control admission fails; producer-retention gates stay silent under dual-queue pressure.
  // Register on the dispatcher so retries survive setWrite replacing a sink; null means permanently gone, not temporarily closed.
  onClientCapacity(clientId: number, listener: () => void): (() => void) | null {
    const client = this.clients.get(clientId)
    if (this.disposed || !client) {
      return null
    }
    const listeners = this.clientCapacityListeners.get(clientId) ?? new Set<() => void>()
    listeners.add(listener)
    this.clientCapacityListeners.set(clientId, listeners)
    return () => {
      const current = this.clientCapacityListeners.get(clientId)
      if (!current?.delete(listener) || current.size > 0) {
        return
      }
      this.clientCapacityListeners.delete(clientId)
    }
  }

  // Invalidation detaches but keeps the primary id for setWrite revival; detach alone does not prove removal.
  isClientAttached(clientId: number): boolean {
    return !this.disposed && this.clients.has(clientId)
  }

  canAdmitControlFrame(clientId: number, estimatedBytes: number): boolean {
    const client = this.clients.get(clientId)
    if (this.disposed || !client || client.closed) {
      return false
    }
    return client.writer.canEnqueueControl(estimatedBytes)
  }

  get legacyRetentionBelowLowWater(): boolean {
    return this.publicationLedger.belowLowWater(() => this.activeClientKeys())
  }

  // Gate by this client’s reserve so a stalled peer cannot pause healthy links; still enforce the relay-wide aggregate ceiling.
  producerRetentionBelowLowWater(clientId: number): boolean {
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      return false
    }
    return this.publicationLedger.belowLowWater([this.clientKey(client)])
  }

  writePrimaryBytes(data: Buffer, lane: 'control' | 'ordinary' = 'control'): boolean {
    if (this.disposed || this.primaryClient.closed) {
      return false
    }
    return this.primaryClient.writer.enqueue(lane, () => data, data.length)
  }

  protected activeClients(): RelayClient[] {
    return Array.from(this.clients.values()).filter((client) => !client.closed)
  }

  protected admitsPtyDataPublication(
    clientId: number,
    params: Readonly<Record<string, unknown>>
  ): boolean {
    return this.ptyDataPublicationAdmission?.(clientId, params) ?? true
  }

  protected activeClientKeys(): string[] {
    return this.activeClients().map((client) => this.clientKey(client))
  }

  protected clientKey(client: RelayClient): string {
    return `${client.id}:${client.generation}`
  }

  protected createWriter(
    client: RelayClient,
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions
  ): DispatcherClientWriter {
    const writer = new DispatcherClientWriter(write, sinkOptions, (error) => {
      this.closeClient(client, error, client !== this.primaryClient)
    })
    writer.onCapacity(() => {
      this.notifyLegacyCapacityIfLow()
      this.notifyClientCapacity(client.id)
    })
    return writer
  }

  protected notifyClientCapacity(clientId: number): void {
    const listeners = this.clientCapacityListeners.get(clientId)
    if (!listeners?.size) {
      return
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (err) {
        process.stderr.write(
          `[relay] Client capacity listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  protected notifyLegacyCapacityIfLow(): void {
    this.notifyLegacyCapacity(false)
  }

  protected notifyLegacyCapacity(force: boolean): void {
    if (this.publicationTransactionDepth > 0) {
      this.deferredForcedLegacyCapacity ||= force
      this.deferredLegacyCapacity ||= !force
      return
    }
    if (!force && !this.publicationLedger.belowLowWater(() => this.activeClientKeys())) {
      return
    }
    for (const listener of this.legacyCapacityListeners) {
      listener()
    }
  }

  protected runPublicationTransaction<T>(operation: () => T): T {
    this.publicationTransactionDepth++
    try {
      return operation()
    } finally {
      this.publicationTransactionDepth--
      if (this.publicationTransactionDepth === 0) {
        const force = this.deferredForcedLegacyCapacity
        const low = this.deferredLegacyCapacity
        this.deferredForcedLegacyCapacity = false
        this.deferredLegacyCapacity = false
        if (force || low) {
          this.notifyLegacyCapacity(force)
        }
      }
    }
  }
}
