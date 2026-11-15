import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { yieldToEventLoop } from '../../../../../../shared/event-loop-yield'
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
  private readonly byKey = new Map<string, Group>()
  private readonly groups = new Map<number, Group>()

  clear(): void {
    this.byKey.clear()
    this.groups.clear()
  }

  async cached(
    input: NativeChatGalleryGroupInput,
    options: ProjectionOptions
  ): Promise<number | null> {
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
    return group.handle
  }

  prepare(
    input: NativeChatGalleryGroupInput,
    options: ProjectionOptions,
    project: () => NativeChatGallerySurface[]
  ): NativeChatGalleryPreparedGroup {
    const started = performance.now()
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
      this.groups.set(group.handle, group)
      this.byKey.set(group.input.key, group)
    }
  }

  async assemble(
    order: readonly number[],
    isCurrent: () => boolean
  ): Promise<NativeChatGalleryEntry[] | null> {
    const entries: NativeChatGalleryEntry[] = []
    const seen = new Set<string>()
    const retained = new Set<number>()
    let visited = 0
    for (const handle of order) {
      retained.add(handle)
      const group = this.groups.get(handle)
      if (!group) {
        throw new Error('Gallery result lost its surface group')
      }
      for (const entry of group.entries) {
        if (!seen.has(entry.key)) {
          seen.add(entry.key)
          entries.push(entry)
        }
        if (++visited % 128 === 0) {
          await yieldToEventLoop()
          if (!isCurrent()) {
            return null
          }
        }
      }
      if (++visited % 128 === 0) {
        await yieldToEventLoop()
      }
      if (!isCurrent()) {
        return null
      }
    }
    for (const [handle, group] of this.groups) {
      if (!retained.has(handle)) {
        this.groups.delete(handle)
        if (this.byKey.get(group.input.key) === group) {
          this.byKey.delete(group.input.key)
        }
      }
      if (++visited % 128 === 0) {
        await yieldToEventLoop()
        if (!isCurrent()) {
          return null
        }
      }
    }
    return entries
  }
}
