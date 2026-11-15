import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { yieldToEventLoop } from '../../../../../../shared/event-loop-yield'
import {
  nativeChatGallerySlotSurfaces,
  nativeChatReasoningImageSurface
} from './native-chat-gallery-surfaces'
import type { NativeChatGalleryEntry } from './native-chat-gallery-entries'
import {
  NativeChatGalleryProjectionCache,
  type NativeChatGalleryPreparedGroup
} from './native-chat-gallery-projection-cache'
import { NativeChatGalleryWorkerClient } from './native-chat-gallery-worker-client'
import type {
  NativeChatGalleryIndexMetrics,
  NativeChatGalleryWorkerCommand,
  NativeChatGalleryWorkerResult
} from './native-chat-gallery-worker-protocol'

export type NativeChatGallerySnapshot = {
  /** Chat/session and runtime generation; changes retire the worker and its cache. */
  scopeKey: string
  slots: readonly NativeChatTranscriptSlot[]
  waitingSlots: readonly NativeChatTranscriptSlot[]
  liveReasoning?: { message: Pick<NativeChatMessage, 'id' | 'blocks'>; growing: boolean }
  stoppedLabel: string
  visuals: boolean
}

export type NativeChatGalleryReady = {
  type: 'ready'
  revision: number
  entries: NativeChatGalleryEntry[]
  metrics: NativeChatGalleryIndexMetrics
}
type Job = {
  revision: number
  snapshot: NativeChatGallerySnapshot
  resolve: (result: NativeChatGalleryReady | null) => void
  reject: (error: Error) => void
}
export class NativeChatGalleryClient {
  private revision = 0
  private scopeKey: string | null = null
  private readonly cache = new NativeChatGalleryProjectionCache()
  private running = false
  private queued: Job | null = null
  private active: Job | null = null
  private readonly channel = new NativeChatGalleryWorkerClient(
    (revision) => revision === this.revision,
    () => this.cache.clear()
  )

  constructor(private readonly onProgress?: (completedSlots: number) => void) {}

  index(snapshot: NativeChatGallerySnapshot): Promise<NativeChatGalleryReady | null> {
    if (this.scopeKey !== null && this.scopeKey !== snapshot.scopeKey) {
      this.close()
    }
    this.scopeKey = snapshot.scopeKey
    this.queued?.resolve(null)
    return new Promise((resolve, reject) => {
      this.queued = { revision: ++this.revision, snapshot, resolve, reject }
      void this.pump()
    })
  }

  close(): void {
    this.revision++
    this.scopeKey = null
    this.queued?.resolve(null)
    this.queued = null
    this.active?.resolve(null)
    this.release(new Error('Gallery closed'))
  }

  private release(error: Error): void {
    this.channel.close(error)
  }

  private request(
    job: Job,
    command: NativeChatGalleryWorkerCommand
  ): Promise<NativeChatGalleryWorkerResult | null> {
    return this.channel.request(job.revision, command)
  }

  private async sendGroups(
    job: Job,
    groups: readonly NativeChatGalleryPreparedGroup[]
  ): Promise<void> {
    if (!groups.length || job.revision !== this.revision) {
      return
    }
    const result = await this.request(job, {
      type: 'put',
      groups: groups.map(({ handle, surfaces, projectionMs }) => ({
        handle,
        surfaces,
        projectionMs
      }))
    })
    if (result?.type === 'groups' && job.revision === this.revision) {
      this.cache.register(groups, result.groups)
    }
  }

  private async appendSlots(
    job: Job,
    slots: readonly NativeChatTranscriptSlot[],
    completed = 0
  ): Promise<number> {
    let reused: number[] = []
    let prepared: NativeChatGalleryPreparedGroup[] = []
    const flushReused = async (): Promise<void> => {
      if (reused.length) {
        await this.request(job, { type: 'reuse', handles: reused })
        reused = []
      }
    }
    const flushPrepared = async (): Promise<void> => {
      await this.sendGroups(job, prepared)
      prepared = []
    }
    for (const slot of slots) {
      if (job.revision !== this.revision) {
        return completed
      }
      completed++
      if (completed % 64 === 0) {
        await flushPrepared()
        await flushReused()
        await yieldToEventLoop()
      }
      if (slot.kind !== 'message' || !slot.drawsMessage || slot.receipt) {
        continue
      }
      const input = {
        key: `slot:${slot.message.id}`,
        message: slot.message,
        workRun: slot.workRun,
        active: slot.activeTurnIsWorking,
        trailing: slot.trailingRun
      }
      const cached = await this.cache.cached(input, job.snapshot)
      if (cached !== null) {
        await flushPrepared()
        reused.push(cached)
      } else {
        await flushReused()
        prepared.push(
          this.cache.prepare(input, job.snapshot, () =>
            nativeChatGallerySlotSurfaces({ ...slot, receipt: false }, job.snapshot)
          )
        )
        if (prepared.length === 32) {
          await flushPrepared()
        }
      }
      this.onProgress?.(completed)
    }
    await flushPrepared()
    await flushReused()
    return completed
  }

  private async run(job: Job): Promise<NativeChatGalleryReady | null> {
    const { snapshot, revision } = job
    await this.request(job, { type: 'begin', scopeKey: snapshot.scopeKey })
    const completed = await this.appendSlots(job, snapshot.slots)
    if (revision !== this.revision) {
      return null
    }
    if (snapshot.liveReasoning) {
      const { message, growing } = snapshot.liveReasoning
      const input = { key: `reasoning:${message.id}`, message, active: growing, trailing: false }
      const cached = await this.cache.cached(input, snapshot)
      await (cached !== null
        ? this.request(job, { type: 'reuse', handles: [cached] })
        : this.sendGroups(job, [
            this.cache.prepare(input, snapshot, () => [
              nativeChatReasoningImageSurface(message, message.id, growing)
            ])
          ]))
    }
    const total = await this.appendSlots(job, snapshot.waitingSlots, completed)
    if (revision !== this.revision) {
      return null
    }
    this.onProgress?.(total)
    const result = await this.request(job, { type: 'commit' })
    if (result?.type !== 'ready') {
      return null
    }
    const entries = await this.cache.assemble(result.order, () => revision === this.revision)
    return entries ? { type: 'ready', revision, entries, metrics: result.metrics } : null
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      while (this.queued) {
        const job = this.queued
        this.queued = null
        this.active = job
        try {
          job.resolve(await this.run(job))
        } catch (error) {
          if (job.revision !== this.revision) {
            job.resolve(null)
          } else {
            job.reject(error instanceof Error ? error : new Error('Unable to index chat images'))
          }
          this.release(new Error('Gallery index abandoned'))
        } finally {
          this.active = null
        }
      }
    } finally {
      this.running = false
    }
  }
}
