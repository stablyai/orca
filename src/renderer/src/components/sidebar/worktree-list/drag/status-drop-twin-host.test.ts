// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../../../shared/workspace-status-defaults'
import { makeFolderWorkspace, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { buildWorktreeManualOrderCatalog } from '../../worktree-manual-order-catalog'
import { useWorktreeStatusMutations } from './use-status-mutations'
import { useWorktreeDropCommitContext } from './use-drop-commit-context'
import { useWorktreeDragSession } from './use-session'
import type { WorktreeDropCommitContext } from './drop-commit-context'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), dismiss: vi.fn() } }))

const REPO_ID = 'repo-twin'
const TWIN_ID = `${REPO_ID}::/src/app`
const OTHER_ID = `${REPO_ID}::/src/other`
const SSH: ExecutionHostId = 'ssh:build-box'
const initialState = useAppStore.getInitialState()
const updateWorktreesMeta = vi.fn().mockResolvedValue(undefined)

// The same worktree id published by this computer and by an SSH host: two sidebar cards.
function seedTwins(extra: Worktree[] = []): { local: Worktree; ssh: Worktree; dragged: Worktree } {
  const local = makeWorktree(TWIN_ID, 'app', { repoId: REPO_ID, hostId: 'local' })
  const ssh = makeWorktree(TWIN_ID, 'app', { repoId: REPO_ID, hostId: SSH })
  const other = makeWorktree(OTHER_ID, 'other', { repoId: REPO_ID, hostId: 'local' })
  useAppStore.setState({
    sortBy: 'manual',
    worktreesByRepo: { [REPO_ID]: [local, other, ssh, ...extra] },
    updateWorktreesMeta
  })
  // Drag whichever copy the id-keyed map did not keep, so a by-id lookup picks the wrong one.
  const kept = getWorktreeMapFromState(useAppStore.getState()).get(TWIN_ID)
  return { local, ssh, dragged: kept?.hostId === SSH ? local : ssh }
}

function renderMutations(sortBy: 'manual' | 'smart' = 'manual') {
  const worktrees = Object.values(useAppStore.getState().worktreesByRepo).flat()
  return renderHook(() =>
    useWorktreeStatusMutations({
      manualOrderCatalog: buildWorktreeManualOrderCatalog({ worktrees, folderWorkspaces: [] }),
      workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
      sortBy
    })
  ).result
}

function written(): {
  worktreeId: string
  updates?: Record<string, unknown>
  executionHostId?: string
}[] {
  return updateWorktreesMeta.mock.calls[0]?.[0] ?? []
}

function writtenHosts(
  worktreeId = TWIN_ID,
  field?: 'workspaceStatus' | 'manualOrder' | 'isPinned'
) {
  return written()
    .filter((u) => u.worktreeId === worktreeId && (!field || field in (u.updates ?? {})))
    .map((u) => u.executionHostId)
    .sort()
}

const copyOf = (row: Worktree) => [{ id: row.id, hostId: row.hostId }]

describe('a sidebar drop on one card of a twin', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    updateWorktreesMeta.mockClear()
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('writes the status to the dragged copy, not the twin the id-keyed map kept', async () => {
    const { dragged } = seedTwins()
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.moveWorktreesToStatusAtIndex({
        worktreeIds: [TWIN_ID],
        status: 'in-review',
        dropIndex: 0,
        groups: [{ key: 'in-review', worktreeIds: [] }],
        draggedCopies: copyOf(dragged)
      })
    })

    expect(writtenHosts(TWIN_ID, 'workspaceStatus')).toEqual([dragged.hostId])
  })

  // Manual order is ranked per id: the catalog drops a rank the copies disagree on.
  it("writes a dragged twin's new rank to every copy so the id keeps one rank", async () => {
    const { dragged } = seedTwins()
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.reorderWorktrees({
        groups: [{ key: 'all', worktreeIds: [OTHER_ID, TWIN_ID] }],
        sourceGroupKey: 'all',
        draggedIds: [TWIN_ID],
        dropIndex: 0,
        draggedCopies: copyOf(dragged)
      })
    })

    expect(writtenHosts(TWIN_ID, 'manualOrder')).toEqual(['local', SSH])
  })

  it('re-ranks every copy of a twin sibling, not whichever one the id-keyed map kept', async () => {
    seedTwins()
    const mutations = renderMutations()
    const other = useAppStore.getState().worktreesByRepo[REPO_ID]!.find((w) => w.id === OTHER_ID)!

    await act(async () => {
      // Drag the unique row between the twin's cards; the twin is only re-ranked, not dragged.
      mutations.current.reorderWorktrees({
        groups: [{ key: 'all', worktreeIds: [TWIN_ID, OTHER_ID] }],
        sourceGroupKey: 'all',
        draggedIds: [OTHER_ID],
        dropIndex: 0,
        draggedCopies: copyOf(other)
      })
    })

    expect(writtenHosts(TWIN_ID, 'manualOrder')).toEqual(['local', SSH])
    expect(writtenHosts(OTHER_ID)).toEqual(['local'])
  })

  it('still ranks an unranked folder workspace that shares the manual-order catalog', async () => {
    const folder = makeFolderWorkspace({ id: 'folder-unranked' })
    const a = makeWorktree(`${REPO_ID}::/a`, 'a', { repoId: REPO_ID, hostId: 'local' })
    const b = makeWorktree(`${REPO_ID}::/b`, 'b', { repoId: REPO_ID, hostId: 'local' })
    useAppStore.setState({
      sortBy: 'manual',
      worktreesByRepo: { [REPO_ID]: [a, b] },
      folderWorkspaces: [folder],
      updateWorktreesMeta
    })
    const catalog = buildWorktreeManualOrderCatalog({
      worktrees: [a, b],
      folderWorkspaces: [folder]
    })
    const { result } = renderHook(() =>
      useWorktreeStatusMutations({
        manualOrderCatalog: catalog,
        workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
        sortBy: 'manual'
      })
    )

    await act(async () => {
      result.current.reorderWorktrees({
        groups: [{ key: 'all', worktreeIds: [a.id, b.id] }],
        sourceGroupKey: 'all',
        draggedIds: [b.id],
        dropIndex: 0,
        draggedCopies: copyOf(b)
      })
    })

    expect(written().map((u) => u.worktreeId)).toContain(folderWorkspaceKey(folder.id))
  })

  it('lands a drop next to an unranked twin when the ranks are first materialized', async () => {
    const b = makeWorktree(`${REPO_ID}::/b`, 'b', {
      repoId: REPO_ID,
      hostId: 'local',
      sortOrder: 2
    })
    const a = makeWorktree(`${REPO_ID}::/a`, 'a', {
      repoId: REPO_ID,
      hostId: 'local',
      sortOrder: 1
    })
    const aOnSsh = { ...a, hostId: SSH }
    useAppStore.setState({
      sortBy: 'manual',
      worktreesByRepo: { [REPO_ID]: [b, a, aOnSsh] },
      updateWorktreesMeta
    })
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.reorderWorktrees({
        groups: [{ key: 'all', worktreeIds: [b.id, a.id] }],
        sourceGroupKey: 'all',
        draggedIds: [b.id],
        dropIndex: 2,
        draggedCopies: copyOf(b)
      })
    })

    const applied = [b, a, aOnSsh].map((row) => {
      const write = written().find(
        (u) => u.worktreeId === row.id && u.executionHostId === row.hostId
      )
      return write ? { ...row, ...write.updates } : row
    })
    expect(
      buildWorktreeManualOrderCatalog({ worktrees: applied, folderWorkspaces: [] }).orderedIds
    ).toEqual([a.id, b.id])
  })

  it('ranks a selected folder workspace dragged together with a git card', async () => {
    const folder = makeFolderWorkspace({ id: 'folder-selected', executionHostId: 'local' })
    const a = makeWorktree(`${REPO_ID}::/a`, 'a', { repoId: REPO_ID, hostId: 'local' })
    const b = makeWorktree(`${REPO_ID}::/b`, 'b', { repoId: REPO_ID, hostId: 'local' })
    useAppStore.setState({
      sortBy: 'manual',
      worktreesByRepo: { [REPO_ID]: [a, b] },
      folderWorkspaces: [folder],
      updateWorktreesMeta
    })
    const folderId = folderWorkspaceKey(folder.id)
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.reorderWorktrees({
        groups: [{ key: 'all', worktreeIds: [a.id, b.id, folderId] }],
        sourceGroupKey: 'all',
        draggedIds: [b.id, folderId],
        dropIndex: 0,
        draggedCopies: [...copyOf(b), { id: folderId, hostId: 'local' }]
      })
    })

    expect(written().map((u) => u.worktreeId)).toContain(folderId)
  })

  it('refuses a dragged copy that left its host mid-drag rather than writing its twin', async () => {
    const { dragged } = seedTwins()
    useAppStore.setState({
      worktreesByRepo: {
        [REPO_ID]: useAppStore.getState().worktreesByRepo[REPO_ID]!.filter((w) => w !== dragged)
      }
    })
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.moveWorktreesToStatus([TWIN_ID], 'in-review', copyOf(dragged))
    })

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
  })

  it("carries a dragged twin's own lineage children, with their host, not the other copy's", () => {
    const { dragged } = seedTwins()
    const twinOf: ExecutionHostId = dragged.hostId === SSH ? 'local' : SSH
    const childOnDraggedHost = makeWorktree(`${REPO_ID}::/src/child-a`, 'child-a', {
      repoId: REPO_ID,
      hostId: dragged.hostId
    })
    const childOfTwin = makeWorktree(`${REPO_ID}::/src/child-b`, 'child-b', {
      repoId: REPO_ID,
      hostId: twinOf
    })
    const twin = { ...dragged, hostId: twinOf }
    const item = (worktree: Worktree, depth: number): HostSectionRow => ({
      type: 'item',
      rowKey: `${worktree.hostId}|${worktree.id}`,
      sectionKey: 'all',
      worktree,
      repo: undefined,
      depth,
      groupDepth: 0,
      isLastLineageChild: depth > 0,
      lineageChildCount: depth === 0 ? 1 : 0
    })
    const rows = [
      item(dragged, 0),
      item(childOnDraggedHost, 1),
      item(twin, 0),
      item(childOfTwin, 1)
    ]
    const { result } = renderHook(() =>
      useWorktreeDragSession({ rows, scrollRef: { current: null } })
    )

    expect(result.current.getReorderDraggedCopies(copyOf(dragged))).toEqual([
      { id: dragged.id, hostId: dragged.hostId },
      { id: childOnDraggedHost.id, hostId: dragged.hostId }
    ])
  })

  it('previews the board insertion line from the dragged copy, as the commit reads it', () => {
    seedTwins()
    const kept = getWorktreeMapFromState(useAppStore.getState()).get(TWIN_ID)
    // The kept twin already sits in the target lane; the dragged copy does not.
    useAppStore.setState({
      sortBy: 'smart',
      worktreesByRepo: {
        [REPO_ID]: useAppStore
          .getState()
          .worktreesByRepo[REPO_ID]!.map((row) =>
            row === kept
              ? { ...row, workspaceStatus: 'in-review' }
              : { ...row, workspaceStatus: 'todo' }
          )
      }
    })
    const dragged = useAppStore
      .getState()
      .worktreesByRepo[REPO_ID]!.find((row) => row.id === TWIN_ID && row.hostId !== kept?.hostId)!
    const mutations = renderMutations('smart')

    expect(
      mutations.current.shouldShowWorkspaceBoardDropIndicator(
        [TWIN_ID],
        'in-review',
        copyOf(dragged)
      )
    ).toBe(false)
  })

  it('pins the dragged copy of a twin dropped on Pinned, not the copy the id-keyed map kept', async () => {
    const { dragged } = seedTwins()
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.pinWorktrees([TWIN_ID], copyOf(dragged))
    })

    expect(writtenHosts(TWIN_ID, 'isPinned')).toEqual([dragged.hostId])
  })

  it('refuses a host-less pin of an id two hosts publish', async () => {
    seedTwins()
    const mutations = renderMutations()

    await act(async () => {
      mutations.current.pinWorktree(TWIN_ID)
      useAppStore.getState().setWorktreesPinnedAndReveal([{ id: TWIN_ID }], true)
    })

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
  })

  it('hands the drop the copies the active drag picked up', () => {
    const onPinWorktrees = vi.fn()
    const onMoveWorktreesToStatusAtIndex = vi.fn()
    const onReorderWorktrees = vi.fn()
    const onMoveWorktreesToStatus = vi.fn()
    const draggedCopies = [{ id: TWIN_ID, hostId: SSH }] as const
    const { result } = renderHook(() =>
      useWorktreeDropCommitContext({
        scrollRef: { current: null },
        workspaceStatuses: [],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the context reads only the drag-session ref and pass-through fields here.
        session: { worktreeDragSessionRef: { current: { draggedCopies } } } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, only the pointer-drag ref is read.
        lineageDrop: {} as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, only the pointer-drag ref is read.
        runtime: { worktreePointerDragRef: { current: null } } as never,
        onMoveWorktreesToStatus,
        onMoveWorktreesToStatusAtIndex,
        onReorderWorktrees,
        onPinWorktrees
      })
    )
    const ctx: WorktreeDropCommitContext = result.current

    ctx.onMoveWorktreesToStatus([TWIN_ID], 'done')
    ctx.onMoveWorktreesToStatusAtIndex({
      worktreeIds: [TWIN_ID],
      status: 'done',
      dropIndex: 0,
      groups: []
    })
    ctx.onReorderWorktrees({
      groups: [],
      sourceGroupKey: 'all',
      draggedIds: [TWIN_ID],
      dropIndex: 0
    })

    expect(onMoveWorktreesToStatus).toHaveBeenCalledWith([TWIN_ID], 'done', draggedCopies)
    expect(onMoveWorktreesToStatusAtIndex.mock.calls[0][0].draggedCopies).toBe(draggedCopies)
    expect(onReorderWorktrees.mock.calls[0][0].draggedCopies).toBe(draggedCopies)
    ctx.onPinWorktrees([TWIN_ID])
    expect(onPinWorktrees).toHaveBeenCalledWith([TWIN_ID], draggedCopies)
  })
})
