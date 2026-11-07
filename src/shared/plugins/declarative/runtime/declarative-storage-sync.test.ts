import { describe, expect, it, vi } from 'vitest'
import { atom, read, set } from './declarative-atoms'
import { h } from './declarative-elements'
import { createOrcaDeclarativeRuntime } from './declarative-renderer'
import type { OrcaBridge } from './declarative-runtime-types'

function storageBridge(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial))
  const listeners = new Set<(change: { key: string }) => void>()
  const storage = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
    delete: vi.fn(async () => undefined),
    keys: vi.fn(async () => [...values.keys()]),
    onDidChange: (listener: (change: { key: string }) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
  const bridge: OrcaBridge = { on: () => ({ dispose: () => undefined }), storage }
  const workerWrites = (key: string, value: unknown) => {
    values.set(key, value)
    for (const listener of listeners) {
      listener({ key })
    }
  }
  return { bridge, storage, workerWrites }
}

describe("persist: 'storage' atoms", () => {
  it("render the plugin's stored value first, write back under their key, and follow the worker", async () => {
    vi.useFakeTimers()
    const { bridge, storage, workerWrites } = storageBridge({ 'sync.todos': ['from worker'] })
    const todos = atom<string[]>('sync.todos', [], { persist: 'storage' })
    const posted: { event: string; payload: unknown }[] = []
    const runtime = createOrcaDeclarativeRuntime({
      post: (event, payload) => posted.push({ event, payload }),
      schedule: (flush) => queueMicrotask(flush),
      bridge
    })
    await runtime.boot({ default: () => h('Text', null, read(todos).join(',')) })
    expect(posted.at(-1)).toMatchObject({ payload: { tree: { children: ['from worker'] } } })

    set(todos, ['mine'])
    vi.advanceTimersByTime(500)
    expect(storage.set).toHaveBeenCalledWith('sync.todos', ['mine'])
    // Storage atoms never ride the panel-state channel.
    expect(posted.some((entry) => entry.event === 'ui.persist')).toBe(false)

    workerWrites('sync.todos', ['worker again'])
    await vi.waitFor(() => expect(read(todos)).toEqual(['worker again']))
    runtime.dispose()
    vi.useRealTimers()
  })
})
