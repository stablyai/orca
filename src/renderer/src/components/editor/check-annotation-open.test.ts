import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  state: {
    getKnownWorktreeById: vi.fn((id: string) =>
      id === 'wt-1' ? { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' } : undefined
    ),
    openFile: vi.fn(),
    setPendingEditorReveal: vi.fn()
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'typescript' }))

import { openAnnotationLocation } from './check-annotation-open'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('openAnnotationLocation', () => {
  it('activates the given host as a surface-providing caller before opening the editor', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    openAnnotationLocation({
      worktreeId: 'wt-1',
      executionHostId: 'ssh:devbox',
      path: 'src/a.ts',
      line: 3
    })

    // The file supplies the initial surface, so do not seed a terminal; host identity prevents switching to a same-ID local twin.
    expect(mocks.state.getKnownWorktreeById).toHaveBeenCalledWith('wt-1', 'ssh:devbox')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'ssh:devbox'
    })
    expect(mocks.state.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', relativePath: 'src/a.ts' }),
      { forceContentReload: true }
    )
  })

  it('does not activate when the worktree is unknown', () => {
    openAnnotationLocation({
      worktreeId: 'missing',
      path: 'src/a.ts',
      line: 3
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openFile).not.toHaveBeenCalled()
  })
})
