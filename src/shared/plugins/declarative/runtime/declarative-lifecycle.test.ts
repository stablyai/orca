import { afterEach, describe, expect, it, vi } from 'vitest'
import { atom, read, set } from './declarative-atoms'

import { createOrcaDeclarativeRuntime, type OrcaBridge } from './declarative-renderer'

function hostBridge() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const bridge: OrcaBridge = {
    on: (name, handler) => {
      handlers.set(name, handler)
      return { dispose: () => handlers.delete(name) }
    }
  }
  return { bridge, send: (name: string, payload: unknown) => handlers.get(name)?.(payload) }
}

function booted() {
  const posted: { event: string; payload: unknown }[] = []
  const host = hostBridge()
  const runtime = createOrcaDeclarativeRuntime({
    post: (event, payload) => posted.push({ event, payload }),
    schedule: (flush) => queueMicrotask(flush),
    bridge: host.bridge,
    awaitHydration: true
  })
  return { runtime, posted, host }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('components panel lifecycle', () => {
  it('posts an edit made just before a workspace switch with its own workspace’s hydration', () => {
    vi.useFakeTimers()
    const { runtime, posted, host } = booted()
    const draft = atom('lifecycle.switchDraft', '', { persist: 'workspace' })
    host.send('ui.hydrate', { hydration: 1, workspace: {} })
    set(draft, 'typed in A')
    vi.advanceTimersByTime(200)
    host.send('ui.hydrate', {
      hydration: 2,
      workspace: { 'lifecycle.switchDraft': { version: 1, value: 'B saved' } }
    })
    vi.advanceTimersByTime(500)
    expect(read(draft)).toBe('B saved')
    expect(posted.filter((entry) => entry.event === 'ui.persist')).toEqual([
      {
        event: 'ui.persist',
        payload: {
          document: runtime.document,
          hydration: 1,
          entries: [
            { scope: 'workspace', key: 'lifecycle.switchDraft', version: 1, value: 'typed in A' }
          ]
        }
      }
    ])
    runtime.dispose()
  })

  it('flushes plugin-scope edits before a hydrate and tags only writes made after a numbered one', () => {
    vi.useFakeTimers()
    const { runtime, posted, host } = booted()
    const shared = atom('lifecycle.switchShared', 0, { persist: 'plugin' })
    const draft = atom('lifecycle.switchUntagged', '', { persist: 'workspace' })
    // Before any numbered hydrate (an older host) a write carries no hydration at all.
    host.send('ui.hydrate', { workspace: {} })
    set(draft, 'untagged')
    vi.advanceTimersByTime(500)
    host.send('ui.hydrate', { hydration: 3, workspace: {} })
    set(shared, 7)
    set(draft, 'in 3')
    host.send('ui.hydrate', {
      hydration: 4,
      plugin: { 'lifecycle.switchShared': { version: 1, value: 7 } }
    })
    vi.advanceTimersByTime(500)
    const keyed = (key: string) => expect.objectContaining({ key })
    const persists = posted.filter((entry) => entry.event === 'ui.persist')
    expect(persists.map((entry) => entry.payload)).toStrictEqual([
      { document: runtime.document, entries: [keyed('lifecycle.switchUntagged')] },
      {
        document: runtime.document,
        hydration: 3,
        entries: [keyed('lifecycle.switchShared'), keyed('lifecycle.switchUntagged')]
      }
    ])
    expect(read(shared)).toBe(7)
    runtime.dispose()
  })
})
