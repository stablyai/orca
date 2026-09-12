import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openMatchResult } from './search-match-open'

type IntendedResultOwner = {
  worktreeId: string
  runtimeEnvironmentId: string | null
}

function openResult(resultOwner: IntendedResultOwner) {
  const openFile = vi.fn()
  const setPendingEditorReveal = vi.fn()
  const params = {
    resultOwner,
    fileResult: {
      filePath: '/owner/repo/src/example.ts',
      relativePath: 'src/example.ts',
      matches: []
    },
    match: {
      line: 7,
      column: 4,
      matchLength: 6,
      lineContent: 'const result = owner'
    },
    openFile,
    setPendingEditorReveal,
    revealRafRef: { current: null },
    revealInnerRafRef: { current: null }
  } satisfies Parameters<typeof openMatchResult>[0]

  openMatchResult(params)
  return { openFile, setPendingEditorReveal }
}

describe('openMatchResult', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('opens with the remote owner captured by the search after the active worktree changes', () => {
    const { openFile } = openResult({
      worktreeId: 'worktree-that-produced-results',
      runtimeEnvironmentId: 'runtime-that-produced-results'
    })

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-that-produced-results',
        runtimeEnvironmentId: 'runtime-that-produced-results'
      }),
      { suppressActiveRuntimeFallback: false }
    )
  })

  it('keeps an explicitly local result local when another runtime is active', () => {
    const { openFile } = openResult({
      worktreeId: 'local-worktree',
      runtimeEnvironmentId: null
    })

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'local-worktree',
        runtimeEnvironmentId: null
      }),
      { suppressActiveRuntimeFallback: true }
    )
  })

  it('does not guess an owner for results without a committed search source', () => {
    const openFile = vi.fn()

    openMatchResult({
      resultOwner: null,
      fileResult: {
        filePath: '/unresolved/repo/file.ts',
        relativePath: 'file.ts',
        matches: []
      },
      match: {
        line: 1,
        column: 1,
        matchLength: 4,
        lineContent: 'test'
      },
      openFile,
      setPendingEditorReveal: vi.fn(),
      revealRafRef: { current: null },
      revealInnerRafRef: { current: null }
    })

    expect(openFile).not.toHaveBeenCalled()
  })
})
