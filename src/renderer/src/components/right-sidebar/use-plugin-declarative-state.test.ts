// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginDeclarativeRetainedMemory } from './plugin-declarative-retained-memory'
import { usePluginDeclarativeState } from './use-plugin-declarative-state'

const store = vi.hoisted(() => ({ activeWorktreeId: 'w1' }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: typeof store) => unknown) => select(store)
}))

const retain = (document: string, entries: unknown[]) => ({ document, entries })

describe('retained memory atoms', () => {
  it('keeps the newest value per key, and forgets a key posted without a value', () => {
    const memory = createPluginDeclarativeRetainedMemory()
    expect(memory.snapshot()).toBeNull()
    expect(memory.accept(retain('d1', [{ key: 'draft', version: 1, value: 'a' }]))).toBe(true)
    memory.accept(
      retain('d1', [
        { key: 'draft', version: 2, value: 'b' },
        { key: 'n', version: 1, value: 3 }
      ])
    )
    expect(memory.snapshot()).toEqual({
      draft: { version: 2, value: 'b' },
      n: { version: 1, value: 3 }
    })
    memory.accept(retain('d1', [{ key: 'n', version: 1 }]))
    expect(memory.snapshot()).toEqual({ draft: { version: 2, value: 'b' } })
    expect(memory.accept(retain('d1', [{ key: 'bad key!', version: 1, value: 1 }]))).toBe(false)
    expect(memory.accept({ entries: [] })).toBe(false)
  })
})

describe('usePluginDeclarativeState hot reload', () => {
  const panelState = vi.fn()

  beforeEach(() => {
    panelState.mockResolvedValue({ ok: true, state: { plugin: {}, workspace: {} } })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { plugins: { panelState } }
    })
  })

  afterEach(() => {
    store.activeWorktreeId = 'w1'
    vi.restoreAllMocks()
  })

  function mount(hotReload: boolean) {
    const send = vi.fn()
    const hook = renderHook(
      ({ hot }: { hot: boolean }) =>
        usePluginDeclarativeState({
          panelId: 'todos',
          sessionToken: 'token',
          visible: true,
          sendToGuest: send,
          hotReload: hot
        }),
      { initialProps: { hot: hotReload } }
    )
    const hydrates = () =>
      send.mock.calls.filter(([event]) => event === 'ui.hydrate').map(([, payload]) => payload)
    return { send, hook, hydrates }
  }

  it("seeds the next guest with the last guest's retained memory atoms, once per guest", async () => {
    const { hook, hydrates } = mount(true)
    act(() => hook.result.current.onGuestEvent('ui.ready', { document: 'd1' }))
    await waitFor(() => expect(hydrates()).toHaveLength(1))
    expect(hydrates()[0]).toEqual({
      panel: { id: 'todos' },
      visible: true,
      plugin: {},
      workspace: {},
      retain: true
    })
    hook.result.current.onGuestEvent(
      'ui.retain',
      retain('d1', [{ key: 'draft', version: 1, value: 'hi' }])
    )

    // A dev save: the next guest asks to hydrate and gets the hand-over.
    act(() => hook.result.current.onGuestEvent('ui.ready', { document: 'd2' }))
    await waitFor(() => expect(hydrates()).toHaveLength(2))
    expect(hydrates()[1]).toMatchObject({
      memory: { draft: { version: 1, value: 'hi' } },
      retain: true
    })

    // A workspace switch re-hydrates the same guest, which must not roll its memory atoms back.
    store.activeWorktreeId = 'w2'
    hook.rerender({ hot: true })
    await waitFor(() => expect(hydrates()).toHaveLength(3))
    expect(hydrates()[2]).not.toHaveProperty('memory')
  })

  it('neither asks for nor keeps memory atoms outside a dev folder', async () => {
    const { hook, hydrates } = mount(false)
    act(() => hook.result.current.onGuestEvent('ui.ready', { document: 'd1' }))
    await waitFor(() => expect(hydrates()).toHaveLength(1))
    expect(hydrates()[0]).not.toHaveProperty('retain')
    hook.result.current.onGuestEvent(
      'ui.retain',
      retain('d1', [{ key: 'draft', version: 1, value: 'hi' }])
    )
    act(() => hook.result.current.onGuestEvent('ui.ready', { document: 'd2' }))
    await waitFor(() => expect(hydrates()).toHaveLength(2))
    expect(hydrates()[1]).not.toHaveProperty('memory')
    expect(panelState).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'write' }))
  })
})
