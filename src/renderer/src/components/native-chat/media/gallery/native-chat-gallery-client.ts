import {
  nativeChatGalleryGroupKey,
  NativeChatGalleryProjectionLimitError
} from './native-chat-gallery-projection-budget'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { yieldToEventLoop } from '../../../../../../shared/concurrency/event-loop-yield'
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
  allowFileUriLinks: boolean
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
  private readyEntries: NativeChatGalleryEntry[] = []
  private restoreIdentities = true
  private readonly channel = new NativeChatGalleryWorkerClient(
    (revision) => revision === this.revision,
    () => {
      this.cache.clear()
      this.restoreIdentities = true
    }
  )

  constructor(private readonly onProgress?: (completedSlots: number) => void) {}

  index(snapshot: NativeChatGallerySnapshot): Promise<NativeChatGalleryReady | null> {
    if (snapshot.scopeKey.length > 1024 || snapshot.stoppedLabel.length > 1024) {
      this.close()
      return Promise.reject(new NativeChatGalleryProjectionLimitError())
    }
    if (this.scopeKey !== null && this.scopeKey !== snapshot.scopeKey) {
      this.close()
    }
    this.scopeKey = snapshot.scopeKey
    this.queued?.resolve(null)
    return new Promise((resolve, reject) => {
      this.queued = { revision: ++this.revision, snapshot, resolve, reject }
      if (this.active) {
        this.release(new Error('Gallery revision superseded'))
      }
      void this.pump()
    })
  }

  close(): void {
    this.revision++
    this.scopeKey = null
    this.queued?.resolve(null)
    this.queued = null
    this.active?.resolve(null)
    this.readyEntries = []
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
    } else {
      this.cache.retirements.enqueue(groups.map((group) => group.handle))
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
        key: nativeChatGalleryGroupKey('slot', slot.message),
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

  private async retainSnapshot(job: Job): Promise<boolean> {
    const keys = new Set<string>()
    let visited = 0
    for (const slots of [job.snapshot.slots, job.snapshot.waitingSlots]) {
      for (const slot of slots) {
        if (slot.kind === 'message' && slot.drawsMessage && !slot.receipt) {
          keys.add(nativeChatGalleryGroupKey('slot', slot.message))
        }
        if (++visited % 64 === 0) {
          await yieldToEventLoop()
          if (job.revision !== this.revision) {
            return false
          }
        }
      }
    }
    if (job.snapshot.liveReasoning) {
      keys.add(nativeChatGalleryGroupKey('reasoning', job.snapshot.liveReasoning.message))
    }
    return this.cache.retainKeys(keys, () => job.revision === this.revision)
  }

  private async releaseRetired(job: Job): Promise<boolean> {
    while (job.revision === this.revision) {
      const handles = this.cache.retirements.peek()
      if (!handles.length) {
        return true
      }
      const result = await this.request(job, { type: 'release', handles })
      if (result?.type !== 'ack' || job.revision !== this.revision) {
        return false
      }
      this.cache.retirements.acknowledge(handles.length)
    }
    return false
  }

  private async run(job: Job): Promise<NativeChatGalleryReady | null> {
    const { snapshot, revision } = job
    if (!(await this.retainSnapshot(job))) {
      return null
    }
    await this.request(job, { type: 'begin', scopeKey: snapshot.scopeKey })
    if (this.restoreIdentities && revision === this.revision) {
      if (this.readyEntries.length) {
        const restored = await this.request(job, { type: 'restore', entries: this.readyEntries })
        if (restored?.type !== 'ack' || revision !== this.revision) {
          return null
        }
      }
      this.restoreIdentities = false
    }
    if (!(await this.releaseRetired(job))) {
      return null
    }
    const completed = await this.appendSlots(job, snapshot.slots)
    if (revision !== this.revision) {
      return null
    }
    if (snapshot.liveReasoning) {
      const { message, growing } = snapshot.liveReasoning
      const input = {
        key: nativeChatGalleryGroupKey('reasoning', message),
        message,
        active: growing,
        trailing: false
      }
      const cached = await this.cache.cached(input, snapshot)
      await (cached !== null
        ? this.request(job, { type: 'reuse', handles: [cached] })
        : this.sendGroups(job, [
            this.cache.prepare(input, snapshot, () => [
              nativeChatReasoningImageSurface(
                message,
                message.id,
                growing,
                snapshot.allowFileUriLinks
              )
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
    if (!entries || revision !== this.revision) {
      return null
    }
    this.readyEntries = entries
    return { type: 'ready', revision, entries, metrics: result.metrics }
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
