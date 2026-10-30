import { Writable } from 'node:stream'
import { RelayDispatcher } from './dispatcher'
import type { PreparedRelayFrame, RelayClient } from './dispatcher-contract'
import type { DispatcherWriterLane, SinkWriteSettlement } from './dispatcher-client-writer'
import { FrameDecoder, MessageType, parseJsonRpcMessage } from './protocol'

type WrittenFrame = { method: string; seq?: number }
type PendingWrite = { frame: WrittenFrame; complete: (error?: Error | null) => void }
type FixedBulkAdmission = {
  clientClosed: boolean
  writerCanAdmitZero: boolean
  retainedProducerBytes: number
  settledBeforeReturn: boolean
  accepted: boolean
}
export const nextBulkWriteTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))

class BulkWriteDispatcher extends RelayDispatcher {
  admissionRetryWakeCount = 0
  fixedBulkAdmissions: FixedBulkAdmission[] = []
  lastCapacityRetry: (() => void) | null = null
  private bulkAdmissionDepth = 0
  private consecutiveFixedBulkRejections = 0

  get capacityRetryCount(): number {
    return this.legacyCapacityListeners.size
  }

  get retainedPublicationBytes(): number {
    return this.publicationLedger.retainedBytes
  }

  override onLegacyPtyCapacity(listener: () => void): () => void {
    this.lastCapacityRetry = listener
    return super.onLegacyPtyCapacity(listener)
  }

  protected override publishPreparedToClient(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    if (lane !== 'bulk') {
      return super.publishPreparedToClient(client, frame, lane, onSettled)
    }
    this.bulkAdmissionDepth++
    try {
      return super.publishPreparedToClient(client, frame, lane, onSettled)
    } finally {
      this.bulkAdmissionDepth--
    }
  }

  protected override notifyLegacyCapacityIfLow(): void {
    if (
      this.bulkAdmissionDepth > 0 &&
      this.capacityRetryCount > 0 &&
      this.legacyRetentionBelowLowWater
    ) {
      this.admissionRetryWakeCount++
    }
    super.notifyLegacyCapacityIfLow()
  }

  protected override enqueuePreparedFrame(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    controlOverflow: 'close-client' | 'reject' = 'close-client'
  ): boolean {
    if (lane !== 'fixed-bulk') {
      return super.enqueuePreparedFrame(client, frame, lane, onSettled, controlOverflow)
    }
    if (this.consecutiveFixedBulkRejections >= 4) {
      throw new Error('Settled fixed-bulk admission retried during writer teardown')
    }
    const before = {
      clientClosed: client.closed,
      writerCanAdmitZero: client.writer.canEnqueueProducer(0),
      retainedProducerBytes: client.writer.retainedProducerBytes
    }
    let settledBeforeReturn = false
    const accepted = super.enqueuePreparedFrame(
      client,
      frame,
      lane,
      (result) => {
        settledBeforeReturn = true
        onSettled(result)
      },
      controlOverflow
    )
    this.fixedBulkAdmissions.push({ ...before, settledBeforeReturn, accepted })
    this.consecutiveFixedBulkRejections = accepted ? 0 : this.consecutiveFixedBulkRejections + 1
    return accepted
  }
}

export function createBulkWriteHarness(highWaterMark = 64 * 1024, producerDataLength = 1024) {
  const frames: WrittenFrame[] = []
  const pending: PendingWrite[] = []
  const sink = new Writable({
    highWaterMark,
    write(bytes: Buffer, _encoding, complete) {
      let frame: WrittenFrame | undefined
      const decoder = new FrameDecoder((decoded) => {
        if (decoded.type !== MessageType.Regular) {
          return
        }
        const message = parseJsonRpcMessage(decoded.payload)
        if (!('method' in message)) {
          return
        }
        frame = {
          method: message.method,
          ...(typeof message.params?.seq === 'number' ? { seq: message.params.seq } : {})
        }
      })
      decoder.feed(bytes)
      if (!frame) {
        throw new Error('Expected one notification frame')
      }
      frames.push(frame)
      pending.push({ frame, complete })
    }
  })
  sink.on('error', () => {})
  const dispatcher = new BulkWriteDispatcher(
    (bytes, settled) =>
      sink.write(bytes, (error) => settled(error ? { ok: false, error } : { ok: true })),
    {
      supportsWriteCallback: true,
      writableLength: () => sink.writableLength,
      writableHighWaterMark: () => sink.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        sink.once('drain', callback)
        return () => sink.off('drain', callback)
      }
    }
  )
  return {
    dispatcher,
    sink,
    frames,
    pending,
    fillProducerQueue(id = 'test-pty', limit = Number.POSITIVE_INFINITY): number {
      let admitted = 0
      const params = { id, data: 'p'.repeat(producerDataLength) }
      while (admitted < limit && dispatcher.tryNotifyPtyData(params)) {
        admitted++
      }
      return admitted
    },
    async releaseOne(error?: Error): Promise<void> {
      pending.shift()?.complete(error)
      await nextBulkWriteTurn()
    },
    async reachBulk(method: string): Promise<void> {
      for (let count = 0; count < 3000; count++) {
        if (pending[0]?.frame.method === method) {
          return
        }
        if (!pending.length) {
          throw new Error('No pending write before bulk admission')
        }
        pending.shift()?.complete()
        await nextBulkWriteTurn()
      }
      throw new Error('Bulk write did not arrive within admitted queue bound')
    },
    async drain(): Promise<void> {
      for (let count = 0; count < 4000; count++) {
        if (!pending.length) {
          await nextBulkWriteTurn()
          if (!pending.length) {
            return
          }
        }
        pending.shift()?.complete()
        await nextBulkWriteTurn()
      }
      throw new Error('Sink did not drain within admitted queue bound')
    },
    dispose(): void {
      dispatcher.dispose()
      sink.destroy()
    }
  }
}
