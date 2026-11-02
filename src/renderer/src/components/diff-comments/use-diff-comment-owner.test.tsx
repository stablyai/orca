// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { makeOpenFile } from '@/store/slices/store-session-test-harness'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import { useCombinedDiffNotesActions } from '../editor/combined-diff/review-controls/use-combined-diff-notes-actions'
import { useMarkdownPreviewSourceFoundation } from '../editor/use-markdown-preview-source-foundation'
import { useSourceControlDiffCommentNotes } from '../right-sidebar/source-control/notes/use-diff-comment-notes'
import { useDiffCommentView, useOwnedDiffCommentTarget } from './use-diff-comment-owner'
import { useVisibleWorktreeDiffComments } from './use-visible-worktree-diff-comments'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
}))

const REPO = 'repo-1'
const WT = `${REPO}::/work/a`
const OTHER = `${REPO}::/work/b`
const initialState = useAppStore.getState()
const SSH_BOX = { kind: 'worktree', authority: { endpoint: { kind: 'self' }, at: 'ssh:box' } }

function row(
  id: string,
  hostId: ExecutionHostId,
  diffComments: DiffComment[] = [],
  runtimeOwnerEnvironmentId?: string
): Worktree {
  return makeWorktree({
    id,
    repoId: REPO,
    path: id.slice(REPO.length + 2),
    hostId,
    diffComments,
    ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
  })
}

function repoOn(id: string, executionHostId: ExecutionHostId): Repo {
  return {
    id,
    path: `/work/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    executionHostId
  }
}

function note(id: string, filePath = 'a.ts'): DiffComment {
  return { id, worktreeId: WT, filePath, lineNumber: 1, body: id, createdAt: 1, side: 'modified' }
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
  vi.mocked(callRuntimeRpc).mockClear()
})

afterEach(() => {
  cleanup()
})

describe('note owner views', () => {
  it('re-render only the consumer whose shown copy changed', () => {
    seedTwins('ssh:box')
    const renders = { open: 0, other: 0 }
    function Probe({ id, name }: { id: string; name: keyof typeof renders }) {
      useDiffCommentView(id, 'selection')
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

  it('do no row work for open Clear confirmations on unrelated writes', () => {
    let idReads = 0
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const id = index === 0 ? WT : `${REPO}::/work/${index}`
      const counted = row(id, 'local', index === 0 ? [note('l1')] : [])
      Object.defineProperty(counted, 'id', {
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        }
      })
      return counted
    })
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { [REPO]: rows }
    })
    const { result } = renderHook(() => {
      const { owner, comments } = useVisibleWorktreeDiffComments(WT, 'selection')
      return {
        combined: useCombinedDiffNotesActions({
          owner,
          clearDiffComments: vi.fn(async () => true),
          diffCommentsForWorktree: comments,
          markdownReviewNotesEnabled: true
        }),
        sourceControl: useSourceControlDiffCommentNotes({
          activeWorktreeId: WT,
          clearDiffComments: vi.fn(async () => true),
          clearDiffCommentsForFile: vi.fn(async () => true)
        }),
        owner
      }
    })
    const owner = result.current.owner
    if (!owner) {
      throw new Error('no owner')
    }
    act(() => result.current.combined.setClearNotesDialogOpen(true))
    act(() =>
      result.current.sourceControl.setPendingDiffCommentsClear({
        kind: 'all',
        worktreeId: WT,
        owner,
        count: 1
      })
    )
    expect(result.current.combined.clearNotesDialogVisible).toBe(true)
    expect(result.current.sourceControl.resolvedPendingDiffCommentsClear).not.toBeNull()

    idReads = 0
    for (let write = 0; write < 20; write += 1) {
      act(() => useAppStore.setState({ editorFontZoomLevel: write }))
    }
    expect(idReads).toBe(0)
  })

  it('do work linear in the catalog on listing and repo updates, none on unrelated writes', () => {
    function cost(size: number) {
      let reads = 0
      const counted = <T extends { id: string }>(record: T): T => {
        const { id } = record
        return Object.defineProperty(record, 'id', {
          enumerable: true,
          get: () => {
            reads += 1
            return id
          }
        })
      }
      const repos = [
        repoOn(REPO, 'local'),
        repoOn(REPO, 'runtime:hub'),
        ...Array.from({ length: size }, (_, index) => repoOn(`unrelated-${index}`, 'local'))
      ].map(counted)
      const rows = Array.from({ length: size }, (_, index) =>
        counted(
          makeWorktree({ id: `${REPO}::/work/${index}`, repoId: REPO, diffComments: [note('n')] })
        )
      )
      useAppStore.setState({ repos, worktreesByRepo: { [REPO]: rows } })
      const ids = rows.map((row) => row.id)
      const { result, unmount } = renderHook(() =>
        ids.map((id) => useDiffCommentView(id, { runtimeEnvironmentId: null }))
      )
      expect(result.current.every((view) => view.comments?.length === 1)).toBe(true)

      reads = 0
      act(() => useAppStore.setState({ worktreesByRepo: { [REPO]: [...rows] } }))
      act(() => useAppStore.setState({ repos: [...repos] }))
      const updateReads = reads
      reads = 0
      act(() => useAppStore.setState({ editorFontZoomLevel: size }))
      expect(reads).toBe(0)
      act(() =>
        useAppStore.setState({
          worktreesByRepo: {
            [REPO]: [{ ...rows[0], id: ids[0], diffComments: [] }, ...rows.slice(1)]
          }
        })
      )
      expect(result.current[0].comments).toEqual([])
      unmount()
      return updateReads
    }

    // N views over N rows and N repos: linear growth is 10x, per-reader catalog scans 100x.
    expect(cost(100)).toBeLessThanOrEqual(cost(10) * 20)
  })

  it('share folder qualification across readers: linear on catalog and server updates, none on unrelated writes', () => {
    function cost(size: number) {
      let reads = 0
      const folders = Array.from({ length: size }, (_, index) => {
        const id = `folder-${index}`
        return Object.defineProperty(
          makeFolderWorkspace({
            id,
            folderPath: `/f/${index}`,
            executionHostId: 'local',
            diffComments: [note('n')]
          }),
          'id',
          {
            enumerable: true,
            get: () => {
              reads += 1
              return id
            }
          }
        )
      })
      useAppStore.setState({
        folderWorkspaces: folders,
        projectGroups: [{ ...makeProjectGroup(), executionHostId: 'local' }]
      })
      // Every folder has a reader, and the first has five more.
      const keys = [
        ...folders.map((folder) => `folder:${folder.id}`),
        ...Array(5).fill('folder:folder-0')
      ]
      const { result, unmount } = renderHook(() =>
        keys.map((key) => useDiffCommentView(key, { runtimeEnvironmentId: null }))
      )
      expect(result.current.every((view) => view.comments?.length === 1)).toBe(true)

      reads = 0
      act(() => useAppStore.setState({ folderWorkspaces: [...folders] }))
      act(() => useAppStore.setState({ runtimeEnvironments: [] }))
      const updateReads = reads
      reads = 0
      act(() => useAppStore.setState({ editorFontZoomLevel: size }))
      expect(reads).toBe(0)
      act(() =>
        useAppStore.setState({
          folderWorkspaces: [
            makeFolderWorkspace({ ...folders[0], id: 'folder-0', diffComments: [] }),
            ...folders.slice(1)
          ]
        })
      )
      expect(result.current.at(-1)?.comments).toEqual([])
      unmount()
      return updateReads
    }

    expect(cost(100)).toBeLessThanOrEqual(cost(10) * 20)
  })

  it('show a sole paired SSH copy selected through its server alias', () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'runtime:hub',
      repos: [
        {
          id: REPO,
          path: '/work/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'box',
          executionHostId: 'runtime:hub'
        }
      ],
      worktreesByRepo: { [REPO]: [row(WT, 'ssh:box', [note('s1')])] }
    })
    const { result } = renderHook(() => useVisibleWorktreeDiffComments(WT, 'selection'))

    expect(result.current.known).toBe(true)
    expect(result.current.comments.map((comment) => comment.body)).toEqual(['s1'])
    expect(result.current.owner).toEqual({
      kind: 'worktree',
      worktreeId: WT,
      authority: { endpoint: { kind: 'environment', environmentId: 'hub' }, at: 'ssh:box' }
    })
  })

  it('tell an unlisted copy apart from a listed copy with no notes', () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: { [REPO]: [row(WT, 'local', [note('l1')])] }
    })
    const { result } = renderHook(() => useVisibleWorktreeDiffComments(WT, 'selection'))
    expect(result.current).toMatchObject({ known: false, comments: [], owner: SSH_BOX })

    act(() => replaceRow('local', WT, []))
    act(() =>
      useAppStore.setState((s) => ({
        worktreesByRepo: { [REPO]: [...s.worktreesByRepo[REPO], row(WT, 'ssh:box')] }
      }))
    )
    expect(result.current).toMatchObject({ known: true, comments: [], owner: SSH_BOX })
  })

  it('keep the composer opener installed before rows load, capturing the copy it opens on', () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: { [REPO]: [] }
    })
    const { result } = renderHook(() =>
      useOwnedDiffCommentTarget<{ line: number }>(WT, 'selection')
    )
    const installedOpener = result.current[1]
    seedTwins('ssh:box')

    act(() => installedOpener({ line: 1 }))
    expect(result.current[2].current).toMatchObject(SSH_BOX)

    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
    act(() => installedOpener((target) => target && { line: target.line + 1 }))
    expect(result.current[1]).toBe(installedOpener)
    expect(result.current[2].current).toMatchObject(SSH_BOX)
  })

  it('read and save a Markdown preview on its source copy, not the selected one', async () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        [REPO]: [
          row(WT, 'local', [{ ...note('local B', 'a.md'), source: 'markdown' }]),
          row(WT, 'runtime:hub', [{ ...note('runtime A', 'a.md'), source: 'markdown' }], 'hub')
        ]
      }
    })
    const { result } = renderHook(() =>
      useMarkdownPreviewSourceFoundation({
        content: 'runtime A content',
        filePath: '/work/a/a.md',
        sourceFileId: null,
        sourceWorktreeId: WT,
        sourceRuntimeEnvironmentId: 'hub',
        prewarmImages: false
      })
    )
    const owner = result.current.commentOwner
    if (!owner) {
      throw new Error('no owner')
    }

    expect(result.current.imageRuntimeContext?.target).toEqual({
      kind: 'environment',
      environmentId: 'hub'
    })
    expect(result.current.markdownComments.map((comment) => comment.body)).toEqual(['runtime A'])
    await act(() =>
      useAppStore.getState().addDiffComment(owner, {
        worktreeId: WT,
        filePath: 'a.md',
        source: 'markdown',
        lineNumber: 1,
        body: 'added',
        side: 'modified'
      })
    )
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'hub' },
      'worktree.set',
      expect.objectContaining({
        diffComments: [
          expect.objectContaining({ body: 'runtime A' }),
          expect.objectContaining({ body: 'added' })
        ]
      }),
      expect.anything()
    )
  })
})

describe('retained sources', () => {
  const markdown = (body: string): DiffComment => ({ ...note(body, 'a.md'), source: 'markdown' })
  const preview = (sourceFileId: string | null) =>
    renderHook(() =>
      useMarkdownPreviewSourceFoundation({
        content: 'content',
        filePath: '/work/a/a.md',
        sourceFileId,
        sourceWorktreeId: WT,
        sourceRuntimeEnvironmentId: null,
        prewarmImages: false
      })
    )

  it('read and save a direct SSH preview on its own copy while the local copy is selected', async () => {
    const updateMeta = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { worktrees: { updateMeta }, ui: { set: vi.fn() } }
    })
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        [REPO]: [row(WT, 'local', [markdown('local B')]), row(WT, 'ssh:box', [markdown('SSH A')])]
      },
      openFiles: [
        makeOpenFile({
          id: 'source-a',
          worktreeId: WT,
          filePath: '/work/a/a.md',
          relativePath: 'a.md',
          runtimeEnvironmentId: null,
          operationProvenance: {
            generation: captureWorktreeOperationGenerationSnapshot({
              executionHostId: 'ssh:box',
              runtimeEnvironmentId: null
            }),
            ownershipProjection: 'explicit'
          }
        })
      ]
    })
    const { result } = preview('source-a')
    const owner = result.current.commentOwner
    if (!owner) {
      throw new Error('no owner')
    }

    expect(result.current.markdownComments.map((comment) => comment.body)).toEqual(['SSH A'])
    await act(() =>
      useAppStore.getState().addDiffComment(owner, {
        worktreeId: WT,
        filePath: 'a.md',
        source: 'markdown',
        lineNumber: 1,
        body: 'added',
        side: 'modified'
      })
    )
    expect(updateMeta).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WT,
      executionHostId: 'ssh:box',
      updates: {
        diffComments: [
          expect.objectContaining({ body: 'SSH A' }),
          expect.objectContaining({ body: 'added' })
        ]
      }
    })
    const local = useAppStore.getState().worktreesByRepo[REPO][0]
    expect(local.diffComments?.map((comment) => comment.body)).toEqual(['local B'])
  })

  it("keep this app's copy for an app source while a server's copy is selected", () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'runtime:hub',
      worktreesByRepo: {
        [REPO]: [
          row(WT, 'local', [markdown('local A')]),
          row(WT, 'runtime:hub', [markdown('hub B')], 'hub')
        ]
      }
    })
    const { result } = preview(null)

    expect(result.current.markdownComments.map((comment) => comment.body)).toEqual(['local A'])
    expect(result.current.commentOwner).toEqual({
      kind: 'worktree',
      worktreeId: WT,
      authority: { endpoint: { kind: 'self' }, at: 'local' }
    })
  })

  it('capture through an installed opener the source the surface shows now', () => {
    useAppStore.setState({
      worktreesByRepo: {
        [REPO]: [row(WT, 'runtime:a', [], 'a'), row(WT, 'runtime:b', [], 'b')]
      }
    })
    const { result, rerender } = renderHook(
      ({ runtimeEnvironmentId }) =>
        useOwnedDiffCommentTarget<{ line: number }>(WT, { runtimeEnvironmentId }),
      { initialProps: { runtimeEnvironmentId: 'a' } }
    )
    const installedOpener = result.current[1]
    rerender({ runtimeEnvironmentId: 'b' })

    act(() => installedOpener({ line: 1 }))
    expect(result.current[2].current).toMatchObject({
      authority: { endpoint: { kind: 'environment', environmentId: 'b' } }
    })
  })
})

describe('captured Clear confirmations', () => {
  it('in combined diff keep the copy they opened on after the selected host changes', async () => {
    seedTwins('ssh:box')
    const clearDiffComments = vi.fn(async () => true)
    const { result } = renderHook(() => {
      const { owner, comments } = useVisibleWorktreeDiffComments(WT, 'selection')
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
      expect.objectContaining(SSH_BOX),
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
      owner: useDiffCommentView(WT, 'selection').owner
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
      expect.objectContaining(SSH_BOX),
      expect.anything()
    )
  })
})
