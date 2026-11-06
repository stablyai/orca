// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted((): { activeWorktreeId: string | null } => ({ activeWorktreeId: 'wt-a' }))
vi.mock('@/store/index', () => ({
  useAppStore: (select: (state: typeof store) => unknown) => select(store)
}))

import { usePluginDeclarativeState } from './use-plugin-declarative-state'

const panelState = vi.fn()

function hydrationOf(payload: unknown): number | undefined {
  return typeof payload === 'object' &&
    payload !== null &&
    'hydration' in payload &&
    typeof payload.hydration === 'number'
    ? payload.hydration
    : undefined
}

beforeEach(() => {
  store.activeWorktreeId = 'wt-a'
  panelState.mockReset()
  panelState.mockImplementation(async (args: { op: string }) =>
    args.op === 'read' ? { ok: true, state: { plugin: {}, workspace: {} } } : { ok: true }
  )
  vi.stubGlobal('api', { plugins: { panelState } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('usePluginDeclarativeState', () => {
  it('stores a write made before a workspace switch under the workspace it was made in', async () => {
    const sendToGuest = vi.fn()
    const { result, rerender } = renderHook(() =>
      usePluginDeclarativeState({ panelId: 'p', sessionToken: 'tok', visible: true, sendToGuest })
    )
    const hydrations = () =>
      sendToGuest.mock.calls
        .filter(([event]) => event === 'ui.hydrate')
        .map(([, payload]) => hydrationOf(payload))
    act(() => result.current.onGuestEvent('ui.ready', { document: 'doc' }))
    await waitFor(() => expect(hydrations()).toHaveLength(1))
    const inA = hydrations()[0]
    store.activeWorktreeId = 'wt-b'
    rerender()
    await waitFor(() => expect(hydrations()).toHaveLength(2))
    // The guest flushes the edit it made in A as the switch's hydrate reaches it.
    act(() =>
      result.current.onGuestEvent('ui.persist', {
        document: 'doc',
        hydration: inA,
        entries: [{ scope: 'workspace', key: 'draft', version: 1, value: 'typed in A' }]
      })
    )
    const writes = panelState.mock.calls.map(([args]) => args).filter((args) => args.op === 'write')
    expect(writes).toEqual([expect.objectContaining({ workspace: 'wt-a' })])
  })
})
