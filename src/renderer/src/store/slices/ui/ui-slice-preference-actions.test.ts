import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from '../ui-slice-test-harness'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setCollapsedGroups', () => {
  it('replaces the collapsed group set and persists it as an array', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setCollapsedGroups(new Set(['pinned', 'repo:orca']))

    expect(store.getState().collapsedGroups).toEqual(new Set(['pinned', 'repo:orca']))
    expect(setUI).toHaveBeenCalledWith({ collapsedGroups: ['pinned', 'repo:orca'] })
  })
})
