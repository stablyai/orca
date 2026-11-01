// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useCombinedDiffNotesActions } from '../editor/combined-diff/review-controls/use-combined-diff-notes-actions'
import { useSourceControlDiffCommentNotes } from '../right-sidebar/source-control/notes/use-diff-comment-notes'
import { useDiffCommentView, useOwnedDiffCommentTarget } from './use-diff-comment-owner'
import { useVisibleWorktreeDiffComments } from './use-visible-worktree-diff-comments'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const REPO = 'repo-1'
const WT = `${REPO}::/work/a`
const OTHER = `${REPO}::/work/b`
const initialState = useAppStore.getState()

function row(id: string, hostId: ExecutionHostId, diffComments: DiffComment[] = []): Worktree {
  return { id, repoId: REPO, path: id.slice(REPO.length + 2), hostId, diffComments } as Worktree
}

function note(id: string, worktreeId = WT): DiffComment {
  return { id, worktreeId, filePath: 'a.ts', lineNumber: 1, body: id, createdAt: 1 }
}

// Same worktree on this computer and on an SSH host, plus an unrelated worktree.
function seedTwins(selected: ExecutionHostId, local = [note('l1'), note('l2')]) {
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: selected,
    worktreesByRepo: {
      [REPO]: [row(WT, 'local', local), row(WT, 'ssh:box', [note('s1')]), row(OTHER, 'local')]
    }
  })
}

function replaceRow(hostId: ExecutionHostId, id: string, diffComments: DiffComment[]) {
  useAppStore.setState((s) => ({
    worktreesByRepo: {
      [REPO]: s.worktreesByRepo[REPO].map((w) =>
        w.id === id && w.hostId === hostId ? { ...w, diffComments } : w
      )
    }
  }))
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
})

describe('note owner views', () => {
  it('re-render only the consumer whose shown copy changed', () => {
    seedTwins('ssh:box')
    const renders = { open: 0, other: 0 }
    function Probe({ id, name }: { id: string; name: keyof typeof renders }) {
      useDiffCommentView(id)
      renders[name] += 1
      return null
    }
    render(
      <>
        <Probe id={WT} name="open" />
        <Probe id={OTHER} name="other" />
      </>
    )
    renders.open = 0
    renders.other = 0

    act(() => useAppStore.setState({ editorFontZoomLevel: 3 }))
    expect(renders).toEqual({ open: 0, other: 0 })

    // The unselected host's copy of the open worktree changes.
    act(() => replaceRow('local', WT, [note('l3')]))
    expect(renders).toEqual({ open: 0, other: 0 })

    act(() => replaceRow('ssh:box', WT, [note('s2')]))
    expect(renders).toEqual({ open: 1, other: 0 })
  })

  it('keep the composer opener installed before rows load, capturing the copy it opens on', () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: { [REPO]: [] }
    })
    const { result } = renderHook(() => useOwnedDiffCommentTarget<{ line: number }>(WT))
    const installedOpener = result.current[1]
    seedTwins('ssh:box')

    act(() => installedOpener({ line: 1 }))
    expect(result.current[2].current).toMatchObject({ kind: 'worktree', hostId: 'ssh:box' })

    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
    act(() => installedOpener((target) => target && { line: target.line + 1 }))
    expect(result.current[1]).toBe(installedOpener)
    expect(result.current[2].current).toMatchObject({ hostId: 'ssh:box' })
  })
})

describe('captured Clear confirmations', () => {
  it('in combined diff keep the copy they opened on after the selected host changes', async () => {
    seedTwins('ssh:box')
    const clearDiffComments = vi.fn(async () => true)
    const { result } = renderHook(() => {
      const { owner, comments } = useVisibleWorktreeDiffComments(WT)
      return useCombinedDiffNotesActions({
        owner,
        clearDiffComments,
        diffCommentsForWorktree: comments,
        markdownReviewNotesEnabled: true
      })
    })

    act(() => result.current.setClearNotesDialogOpen(true))
    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))

    expect(result.current.clearNotesDialogVisible).toBe(true)
    expect(result.current.clearNotesCount).toBe(1)
    await act(() => result.current.handleConfirmClearNotes())
    expect(clearDiffComments).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostId: 'ssh:box' }),
      expect.anything()
    )
  })

  it('in source control keep the copy they opened on after the selected host changes', async () => {
    seedTwins('ssh:box')
    const clearDiffComments = vi.fn(async () => true)
    const { result } = renderHook(() => ({
      notes: useSourceControlDiffCommentNotes({
        activeWorktreeId: WT,
        clearDiffComments,
        clearDiffCommentsForFile: vi.fn(async () => true)
      }),
      owner: useDiffCommentView(WT).owner
    }))
    const owner = result.current.owner
    if (!owner) {
      throw new Error('no owner')
    }

    act(() =>
      result.current.notes.setPendingDiffCommentsClear({
        kind: 'all',
        worktreeId: WT,
        owner,
        count: 1
      })
    )
    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))

    expect(result.current.notes.resolvedPendingDiffCommentsClear).not.toBeNull()
    expect(result.current.notes.pendingDiffCommentsClearCount).toBe(1)
    await act(() => result.current.notes.handleConfirmDiffCommentsClear())
    expect(clearDiffComments).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostId: 'ssh:box' }),
      expect.anything()
    )
  })
})
