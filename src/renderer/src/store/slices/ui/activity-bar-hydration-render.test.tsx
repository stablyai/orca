// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('does not re-render arrangement subscribers when unrelated UI state hydrates', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  const store = createUIStore()
  const ui = makePersistedUI({
    activityBarOrder: ['explorer', 'plugin:a'],
    activityBarHidden: ['plugin:a']
  })
  store.getState().hydratePersistedUI(ui)
  let renders = 0
  function Subscriber(): null {
    useStore(
      store,
      useShallow((s) => ({ order: s.activityBarOrder, hidden: s.activityBarHidden }))
    )
    renders += 1
    return null
  }
  render(<Subscriber />)
  const initial = renders
  for (let i = 0; i < 100; i += 1) {
    act(() =>
      store.getState().hydratePersistedUI(makePersistedUI({ ...ui, sidebarWidth: 300 + i }), 'sync')
    )
  }
  expect(renders).toBe(initial)
})
