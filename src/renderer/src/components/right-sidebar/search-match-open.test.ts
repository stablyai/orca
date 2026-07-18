import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openMatchResult } from './search-match-open'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

const fileResult: SearchFileResult = {
  filePath: '/remote/repo/src/index.ts',
  relativePath: 'src/index.ts',
  matches: []
} as unknown as SearchFileResult

const match: SearchMatch = {
  line: 3,
  column: 5,
  matchLength: 4
} as unknown as SearchMatch

function makeParams(runtimeEnvironmentId: string | null): {
  openFile: ReturnType<typeof vi.fn>
  run: () => void
} {
  const openFile = vi.fn()
  const setPendingEditorReveal = vi.fn()
  const revealRafRef = { current: null }
  const revealInnerRafRef = { current: null }
  return {
    openFile,
    run: () =>
      openMatchResult({
        activeWorktreeId: 'wt-1',
        runtimeEnvironmentId,
        fileResult,
        match,
        openFile,
        setPendingEditorReveal,
        revealRafRef,
        revealInnerRafRef
      })
  }
}

describe('openMatchResult runtime ownership', () => {
  it('opens a runtime-owned match through the owning runtime environment', () => {
    const { openFile, run } = makeParams('env-remote-1')
    run()
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/remote/repo/src/index.ts',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: 'env-remote-1'
      }),
      { suppressActiveRuntimeFallback: false }
    )
  })

  it('pins an explicitly local worktree to local reads instead of the active runtime', () => {
    const { openFile, run } = makeParams(null)
    run()
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnvironmentId: undefined
      }),
      { suppressActiveRuntimeFallback: true }
    )
  })
})
