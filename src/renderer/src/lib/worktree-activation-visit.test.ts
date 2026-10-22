import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '@/store/types'
import { markVisited } from './worktree-activation-visit'
import { revealWorkspaceSurface } from './workspace-surface-reveal'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

beforeEach(() => {
  vi.useFakeTimers({ now: 50_000, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('markVisited with the sidebar-inputs switch on', () => {
  it('stamps a folder workspace you leave under its own key', () => {
    const markWorktreeVisited = vi.fn()
    const state = {
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      markWorktreeVisited
    }
    markVisited(state, 'repo::/next', { worktreeId: 'folder:f1', hostId: 'local' })
    expect(markWorktreeVisited.mock.calls).toEqual([
      ['folder:f1', 49_999, 'local'],
      ['repo::/next', 50_000]
    ])
  })

  it('treats the same id on another host as leaving, and a reselect as not', () => {
    const markWorktreeVisited = vi.fn()
    const state = {
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      markWorktreeVisited
    }
    markVisited(state, 'repo::/w', { worktreeId: 'repo::/w', hostId: 'ssh:a' }, 'ssh:b')
    expect(markWorktreeVisited.mock.calls[0]).toEqual(['repo::/w', 49_999, 'ssh:a'])
    markWorktreeVisited.mockClear()
    markVisited(state, 'repo::/w', { worktreeId: 'repo::/w', hostId: 'ssh:a' }, 'ssh:a')
    expect(markWorktreeVisited.mock.calls).toEqual([['repo::/w', 50_000]])
  })

  it('a terminal link or CLI focus that reveals another workspace stamps the one you leave', () => {
    const markWorktreeVisited = vi.fn()
    revealWorkspaceSurface(
      {
        settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: false },
        floatingWorkspacePanelOpen: false,
        updateSettings: vi.fn<AppState['updateSettings']>(async () => {}),
        setActiveView: vi.fn(),
        setActiveWorktree: vi.fn(() => true),
        markWorktreeVisited,
        recordWorktreeVisit: vi.fn(),
        isNavigatingHistory: false,
        revealWorktreeInSidebar: vi.fn(),
        activeWorktreeId: 'repo::/shells',
        activeWorkspaceExecutionHostId: 'local'
      },
      'repo::/linked'
    )
    expect(markWorktreeVisited.mock.calls).toEqual([
      ['repo::/shells', 49_999, 'local'],
      ['repo::/linked', 50_000]
    ])
  })
})
