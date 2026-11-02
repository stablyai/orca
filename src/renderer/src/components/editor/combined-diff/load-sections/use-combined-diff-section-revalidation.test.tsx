// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import type { OpenFile } from '@/store/slices/editor'
import type { FsChangedPayload } from '../../../../../../shared/filesystem-entry-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionRevalidation } from './use-combined-diff-section-revalidation'

const review: OpenFile = {
  id: 'combined',
  worktreeId: 'wt',
  filePath: '/repo',
  relativePath: 'Changes',
  language: 'plaintext',
  isDirty: false,
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}

function renderReview(): ReturnType<typeof vi.fn> {
  const requestSectionReload = vi.fn()
  renderHook(() =>
    useCombinedDiffSectionRevalidation({
      file: review,
      gitStatusEntries: [],
      // Why: index 3 is mid-read; that read may predate the missed write.
      registry: {
        loadedIndicesRef: { current: new Set([0, 2]) },
        loadingIndicesRef: { current: new Set([2, 3]) }
      },
      requestSectionReload,
      sectionIndexByKeyRef: { current: new Map() },
      sectionEntries: [],
      // Why: snapshot-backed reviews skip status-driven reloads, so only the catch-up can refresh them.
      shouldAutoReloadFromGitStatus: false,
      treeMode: 'uncommitted'
    })
  )
  return requestSectionReload
}

function dispatch(payload: FsChangedPayload, runtimeEnvironmentId: string | null = null): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: { payload, runtimeEnvironmentId }
      })
    )
  })
}

afterEach(cleanup)

it('reloads only loaded rows whose own path status changed', () => {
  const file: OpenFile = { ...review, combinedAreaFilter: 'unstaged' }
  const unstaged: GitStatusEntry[] = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({
    path,
    status: 'modified',
    area: 'unstaged'
  }))
  const staged: GitStatusEntry = { ...unstaged[1]!, area: 'staged', added: 1 }
  const requestSectionReload = vi.fn()
  const registry = {
    loadedIndicesRef: { current: new Set([0, 1, 2]) },
    loadingIndicesRef: { current: new Set<number>() }
  }
  const sectionsRef = { current: [] }
  const hook = renderHook(
    ({ entries }: { entries: GitStatusEntry[] }) => {
      const entrySet = useCombinedDiffEntrySet({
        file,
        gitStatusEntries: entries,
        liveBranchEntries: [],
        sectionsRef
      })
      useCombinedDiffSectionRevalidation({
        file,
        gitStatusEntries: entries,
        registry,
        requestSectionReload,
        sectionIndexByKeyRef: { current: new Map() },
        sectionEntries: entrySet.entries,
        shouldAutoReloadFromGitStatus: entrySet.shouldAutoReloadFromGitStatus,
        treeMode: entrySet.treeMode
      })
    },
    { initialProps: { entries: [...unstaged, staged] } }
  )

  hook.rerender({ entries: [staged, unstaged[2]!, unstaged[0]!, unstaged[1]!] })
  expect(requestSectionReload).not.toHaveBeenCalled()

  hook.rerender({ entries: [...unstaged, { ...staged, added: 2 }] })
  hook.rerender({ entries: unstaged })
  expect(requestSectionReload.mock.calls).toEqual([[1], [1]])
})

it('re-reads every loaded and in-flight section of a mounted review when its workspace catches up', () => {
  const requestSectionReload = renderReview()
  dispatch({
    worktreePath: '/repo',
    events: [{ kind: 'overflow', absolutePath: '/repo' }],
    resync: true
  })
  expect(requestSectionReload.mock.calls).toEqual([[0], [2], [3]])
})

it('ignores other workspaces, other hosts, path events and storm overflows', () => {
  const requestSectionReload = renderReview()
  const resync = (worktreePath: string): FsChangedPayload => ({
    worktreePath,
    events: [{ kind: 'overflow', absolutePath: worktreePath }],
    resync: true
  })
  dispatch(resync('/other'))
  dispatch(resync('/repo'), 'env-1')
  dispatch({
    worktreePath: '/repo',
    events: [{ kind: 'update', absolutePath: '/repo/a.ts' }]
  })
  // Storm overflow refreshes status only; rereading every section per flush would fan out.
  dispatch({
    worktreePath: '/repo',
    events: [{ kind: 'overflow', absolutePath: '/repo' }]
  })
  expect(requestSectionReload).not.toHaveBeenCalled()
})
