import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '@/store/types'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { revealWorkspaceSurface, selectWorkspaceSurface } from './workspace-surface-reveal'

const dispatchEvent = vi.fn()

function revealState(isNavigatingHistory = false) {
  return {
    settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
    floatingWorkspacePanelOpen: false,
    updateSettings: vi.fn<AppState['updateSettings']>(async () => {}),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(() => true),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    isNavigatingHistory,
    revealWorktreeInSidebar: vi.fn()
  }
}

const panelToggled = expect.objectContaining({ type: TOGGLE_FLOATING_TERMINAL_EVENT })

beforeEach(() => vi.stubGlobal('window', { dispatchEvent }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('revealWorkspaceSurface', () => {
  it('opens the floating panel and leaves the main window as it is', () => {
    const state = revealState()

    revealWorkspaceSurface(state, FLOATING_TERMINAL_WORKTREE_ID, ['tab-1'])

    expect(dispatchEvent).toHaveBeenCalledWith(panelToggled)
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(state.markWorktreeVisited).not.toHaveBeenCalled()
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it.each(['repo::/wt', 'folder:fw-1'])('selects %s in the main window as a visit', (id) => {
    const state = revealState()

    revealWorkspaceSurface(state, id)

    expect(dispatchEvent).not.toHaveBeenCalled()
    expect(state.setActiveView).toHaveBeenCalledWith('terminal')
    expect(state.setActiveWorktree).toHaveBeenCalledWith(id)
    expect(state.markWorktreeVisited).toHaveBeenCalledWith(id)
    expect(state.recordWorktreeVisit).toHaveBeenCalledWith(id)
    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith(id)
  })

  it('passes created tabs through and skips the history entry while navigating history', () => {
    const state = revealState(true)

    revealWorkspaceSurface(state, 'repo::/wt', ['tab-1'])

    expect(state.setActiveWorktree).toHaveBeenCalledWith('repo::/wt', undefined, {
      createdTabIds: ['tab-1']
    })
    expect(state.markWorktreeVisited).toHaveBeenCalledWith('repo::/wt')
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
  })
})

describe('selectWorkspaceSurface', () => {
  it('opens the floating panel instead of selecting the floating workspace', () => {
    const state = revealState()

    selectWorkspaceSurface(state, FLOATING_TERMINAL_WORKTREE_ID)

    expect(dispatchEvent).toHaveBeenCalledWith(panelToggled)
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('selects any other workspace without navigating to it', () => {
    const state = revealState()

    selectWorkspaceSurface(state, 'repo::/wt')

    expect(dispatchEvent).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).toHaveBeenCalledWith('repo::/wt')
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.markWorktreeVisited).not.toHaveBeenCalled()
    expect(state.recordWorktreeVisit).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })
})
