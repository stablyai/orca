import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

type OpenFile = AppState['openFiles'][number]

const REMOVED = 'repo-1::/repos/one/removed'
const KEPT = 'repo-1::/repos/one/kept'

function fileFor(worktreeId: string, id: string): OpenFile {
  return { id, worktreeId, path: `${worktreeId}/f.ts`, name: 'f.ts' } as unknown as OpenFile
}

function buildState(openFiles: OpenFile[]): AppState {
  return {
    worktreesByRepo: { 'repo-1': [] },
    tabsByWorktree: { [KEPT]: [] },
    openFiles,
    everActivatedWorktreeIds: new Set<string>(),
    lastVisitedAtByWorktreeId: {},
    deleteStateByWorktreeId: {},
    sortEpoch: 0
  } as unknown as AppState
}

function removeWorktree(state: AppState): AppState {
  let current = state
  applyRemoveWorktreeSuccessState(
    (update) => {
      const patch = typeof update === 'function' ? update(current) : update
      current = { ...current, ...patch }
    },
    REMOVED,
    new Set<string>()
  )
  return current
}

describe('worktree removal openFiles identity', () => {
  it('keeps the openFiles reference when the removed worktree had no open file', () => {
    // openFiles is selected whole by the editor panel, file explorer and git-status
    // polling, so a fresh array here rerenders all of them for no data change.
    const before = buildState([fileFor(KEPT, 'kept-file')])

    const after = removeWorktree(before)

    expect(after.openFiles).toBe(before.openFiles)
  })

  it('still drops the removed worktree files', () => {
    const before = buildState([fileFor(KEPT, 'kept-file'), fileFor(REMOVED, 'gone-file')])

    const after = removeWorktree(before)

    expect(after.openFiles).not.toBe(before.openFiles)
    expect(after.openFiles.map((f) => f.id)).toEqual(['kept-file'])
  })
})
