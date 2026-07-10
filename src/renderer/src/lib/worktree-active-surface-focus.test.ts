import { describe, expect, it } from 'vitest'
import { resolveWorktreeActiveSurfaceFocus } from './worktree-active-surface-focus'

type State = Parameters<typeof resolveWorktreeActiveSurfaceFocus>[0]

function makeState(overrides: Partial<State> = {}): State {
  return {
    activeTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  } as State
}

describe('resolveWorktreeActiveSurfaceFocus', () => {
  it('routes an active terminal tab to its persisted active leaf', () => {
    const state = makeState({
      activeTabIdByWorktree: { 'wt-1': 'terminal-1' },
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      terminalLayoutsByTabId: { 'terminal-1': { activeLeafId: 'leaf-9' } as never }
    })

    expect(resolveWorktreeActiveSurfaceFocus(state, 'wt-1')).toEqual({
      kind: 'terminal',
      tabId: 'terminal-1',
      leafId: 'leaf-9'
    })
  })

  it('routes a terminal tab with no persisted layout to a null leaf', () => {
    const state = makeState({
      activeTabIdByWorktree: { 'wt-1': 'terminal-1' },
      activeTabTypeByWorktree: { 'wt-1': 'terminal' }
    })

    expect(resolveWorktreeActiveSurfaceFocus(state, 'wt-1')).toEqual({
      kind: 'terminal',
      tabId: 'terminal-1',
      leafId: null
    })
  })

  it('routes an editor tab to the editor surface', () => {
    const state = makeState({
      activeTabIdByWorktree: { 'wt-1': 'file-1' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    })

    expect(resolveWorktreeActiveSurfaceFocus(state, 'wt-1')).toEqual({ kind: 'editor' })
  })

  it('falls back when the tab type is terminal but the tab id is missing', () => {
    const state = makeState({ activeTabTypeByWorktree: { 'wt-1': 'terminal' } })

    expect(resolveWorktreeActiveSurfaceFocus(state, 'wt-1')).toEqual({ kind: 'fallback' })
  })

  it('falls back for browser / simulator / unknown active tab types', () => {
    const state = makeState({
      activeTabIdByWorktree: { 'wt-1': 'page-1' },
      activeTabTypeByWorktree: { 'wt-1': 'browser' as never }
    })

    expect(resolveWorktreeActiveSurfaceFocus(state, 'wt-1')).toEqual({ kind: 'fallback' })
    expect(resolveWorktreeActiveSurfaceFocus(makeState(), 'unknown-wt')).toEqual({
      kind: 'fallback'
    })
  })
})
