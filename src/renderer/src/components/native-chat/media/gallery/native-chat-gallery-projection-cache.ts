import {
  assertNativeChatGalleryProjection,
  NativeChatGalleryProjectionLimitError
} from './native-chat-gallery-projection-budget'
import { NativeChatGalleryRetirementQueue } from './native-chat-gallery-retirement-queue'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { yieldToEventLoop } from '../../../../../../shared/concurrency/event-loop-yield'
import type { NativeChatGalleryEntry } from './native-chat-gallery-entries'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'

type ProjectionOptions = { stoppedLabel: string; visuals: boolean }
export type NativeChatGalleryGroupInput = {
  key: string
  message: Pick<NativeChatMessage, 'id' | 'blocks'>
  workRun?: readonly NativeChatMessage[]
  active: boolean
  trailing: boolean
}
type Group = {
  handle: number
  input: NativeChatGalleryGroupInput
  options: ProjectionOptions
  entries: NativeChatGalleryEntry[]
}
export type NativeChatGalleryPreparedGroup = {
  handle: number
  input: NativeChatGalleryGroupInput
  options: ProjectionOptions
  surfaces: NativeChatGallerySurface[]
  projectionMs: number
}

export class NativeChatGalleryProjectionCache {
  private nextHandle = 0
  private byKey = new Map<string, Group>()
  private groups = new Map<number, Group>()
  private committed = new Set<number>()
  private generation = 0
  readonly retirements = new NativeChatGalleryRetirementQueue()

  clear(): void {
    this.byKey = new Map()
    this.groups = new Map()
    this.committed = new Set()
    this.retirements.clear()
    this.generation++
  }

  async cached(
    input: NativeChatGalleryGroupInput,
    options: ProjectionOptions
  ): Promise<number | null> {
    if (input.key.length > 1040) {
      throw new NativeChatGalleryProjectionLimitError()
    }
    const generation = this.generation
    const group = this.byKey.get(input.key)
    const before = group?.input
    if (
      !group ||
      !before ||
      before.message !== input.message ||
      before.active !== input.active ||
      before.trailing !== input.trailing ||
      group.options.visuals !== options.visuals ||
      group.options.stoppedLabel !== options.stoppedLabel
    ) {
      return null
    }
    if (before.workRun === input.workRun) {
      return group.handle
    }
    if (!before.workRun || !input.workRun || before.workRun.length !== input.workRun.length) {
      return null
    }
    for (let index = 0; index < input.workRun.length; index++) {
      if (before.workRun[index] !== input.workRun[index]) {
        return null
      }
      if (index % 128 === 127) {
        await yieldToEventLoop()
      }
    }
    return generation === this.generation ? group.handle : null
  }

  prepare(
    input: NativeChatGalleryGroupInput,
    options: ProjectionOptions,
    project: () => NativeChatGallerySurface[]
  ): NativeChatGalleryPreparedGroup {
    if (input.key.length > 1040) {
      throw new NativeChatGalleryProjectionLimitError()
    }
    const started = performance.now()
    assertNativeChatGalleryProjection(input)
    const surfaces = project()
    return {
      handle: ++this.nextHandle,
      input,
      options: { stoppedLabel: options.stoppedLabel, visuals: options.visuals },
      surfaces,
      projectionMs: performance.now() - started
    }
  }

  register(
    prepared: readonly NativeChatGalleryPreparedGroup[],
    results: readonly { handle: number; entries: NativeChatGalleryEntry[] }[]
  ): void {
    if (prepared.length !== results.length) {
      throw new Error('Gallery response lost a projected group')
    }
    for (let index = 0; index < prepared.length; index++) {
      const source = prepared[index]!
      const result = results[index]!
      if (source.handle !== result.handle) {
        throw new Error('Gallery response changed its projected group')
      }
      const group = {
        handle: source.handle,
        input: source.input,
        options: source.options,
        entries: result.entries
      }
      const previous = this.byKey.get(group.input.key)
      if (previous && !this.committed.has(previous.handle)) {
        this.groups.delete(previous.handle)
        this.retirements.enqueue([previous.handle])
      }
      this.groups.set(group.handle, group)
      this.byKey.set(group.input.key, group)
    }
  }

  async retainKeys(keys: ReadonlySet<string>, isCurrent: () => boolean): Promise<boolean> {
    const generation = this.generation
    let visited = 0
    for (const [handle, group] of this.groups) {
      if (!this.committed.has(handle) && !keys.has(group.input.key)) {
        this.groups.delete(handle)
        if (this.byKey.get(group.input.key) === group) {
          this.byKey.delete(group.input.key)
        }
        this.retirements.enqueue([handle])
      }
      if (++visited % 128 === 0) {
        await yieldToEventLoop()
        if (!isCurrent() || generation !== this.generation) {
          return false
        }
      }
    }
    return isCurrent() && generation === this.generation
  }

  async assemble(
    order: readonly number[],
    isCurrent: () => boolean
  ): Promise<NativeChatGalleryEntry[] | null> {
    const generation = this.generation
    const valid = (): boolean => {
      if (!isCurrent()) {
        return false
      }
      if (generation !== this.generation) {
        throw new Error('Gallery worker retired during assembly')
      }
      return true
    }
    const entries: NativeChatGalleryEntry[] = []
    const nextByKey = new Map<string, Group>()
    const nextGroups = new Map<number, Group>()
    const retired: number[] = []
    const seen = new Set<string>()
    const retained = new Set<number>()
    let visited = 0
    for (const handle of order) {
      retained.add(handle)
      const group = this.groups.get(handle)
      if (!group) {
        throw new Error('Gallery result lost its surface group')
      }
      nextByKey.set(group.input.key, group)
      nextGroups.set(handle, group)
      for (const entry of group.entries) {
        if (entry.key.length > 64) {
          throw new Error('Gallery result contains an oversized identity')
        }
        if (!seen.has(entry.key)) {
          seen.add(entry.key)
          entries.push(entry)
        }
        if (++visited % 128 === 0) {
          await yieldToEventLoop()
          if (!valid()) {
            return null
          }
        }
      }
      if (++visited % 128 === 0) {
        await yieldToEventLoop()
      }
      if (!valid()) {
        return null
      }
    }
    for (const handle of this.groups.keys()) {
      if (!retained.has(handle)) {
        retired.push(handle)
      }
      if (++visited % 128 === 0) {
        await yieldToEventLoop()
        if (!valid()) {
          return null
        }
      }
    }
    if (!valid()) {
      return null
    }
    this.byKey = nextByKey
    this.groups = nextGroups
    this.committed = retained
    this.retirements.enqueue(retired)
    return entries
  }
}
