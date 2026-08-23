import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createUISlice collapsed groups', () => {
  it('collapses multiple sidebar groups in one persisted update', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ collapsedGroups: new Set(['project:one']) })
    store.getState().collapseGroups(['project:one', 'project:two'])

    expect([...store.getState().collapsedGroups]).toEqual(['project:one', 'project:two'])
    expect(setUI).toHaveBeenCalledOnce()
    expect(setUI).toHaveBeenCalledWith({
      collapsedGroups: ['project:one', 'project:two']
    })
  })

  it('does not persist when every requested sidebar group is already collapsed', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()
    const collapsedGroups = new Set(['project:one'])

    store.setState({ collapsedGroups })
    store.getState().collapseGroups(['project:one'])

    expect(store.getState().collapsedGroups).toBe(collapsedGroups)
    expect(setUI).not.toHaveBeenCalled()
  })
})
