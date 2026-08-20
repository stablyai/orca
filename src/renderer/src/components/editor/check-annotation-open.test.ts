import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  state: {
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }] },
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
  it('activates as a surface-providing caller before opening the editor', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    openAnnotationLocation({
      worktreeId: 'wt-1',
      path: 'src/a.ts',
      line: 3,
      revealRafRef: { current: null },
      revealInnerRafRef: { current: null }
    })

    // Why: the annotation's editor file is the surface — the jump must not re-seed
    // a shell into a workspace whose last terminal the user closed.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
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
      line: 3,
      revealRafRef: { current: null },
      revealInnerRafRef: { current: null }
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openFile).not.toHaveBeenCalled()
  })
})
