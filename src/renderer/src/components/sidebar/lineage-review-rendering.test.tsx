import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useWorktreeLineageDropCommit } from './worktree-list/drag/use-lineage-drop-commit'
import type { WorktreeSidebarDragSession } from './worktree-sidebar-drag-autoscroll'
import type { WorktreeRow } from './worktree-list/grouping/row-types'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'

type State = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'worktreeLineageById'
  | 'assignWorktreeParent'
  | 'updateWorktreeLineage'
>
const mocks = vi.hoisted<{ state?: State }>(() => ({}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: State | undefined) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

function repo(hostId: Repo['executionHostId']): Repo {
  return {
    id: 'repo',
    displayName: `Repo on ${hostId}`,
    path: '/repo',
    badgeColor: '',
    addedAt: 1,
    executionHostId: hostId
  }
}

function row(worktree: Worktree): WorktreeRow {
  return {
    type: 'item',
    worktree,
    rowKey: `${worktree.hostId}:${worktree.runtimeOwnerEnvironmentId}:${worktree.id}`,
    sectionKey: 'all',
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

describe('reviewed lineage UI ownership', () => {
  beforeEach(() => {
    mocks.state = {
      repos: [],
      worktreesByRepo: {},
      worktreeLineageById: {},
      assignWorktreeParent: vi.fn().mockResolvedValue(undefined),
      updateWorktreeLineage: vi.fn().mockResolvedValue(undefined)
    }
  })

  it('renders a sole SSH repo badge and combines stamped and legacy child counts', () => {
    const state = mocks.state!
    state.repos = [repo('ssh:remote')]
    const legacy = makeWorktree({ id: 'repo::/legacy', repoId: 'repo' })
    const stamped = makeWorktree({ id: 'repo::/stamped', repoId: 'repo', hostId: 'ssh:remote' })
    const markup = renderToStaticMarkup(
      <DeleteWorktreeLineageNotice
        descendants={[legacy, stamped]}
        dirtyChangeCountsByWorktreeId={new Map()}
      />
    )
    expect(markup.match(/Repo on ssh:remote/g)).toHaveLength(3)
    expect(markup).toContain('(2)')
  })

  it.each(['ssh:remote', 'runtime:hub'] as const)(
    'pins a colliding drag to its visible owner %s',
    (hostId) => {
      const state = mocks.state!
      const child = makeWorktree({
        id: 'repo::/child',
        repoId: 'repo',
        hostId,
        instanceId: 'remote-child'
      })
      const parent = makeWorktree({
        id: 'repo::/parent',
        repoId: 'repo',
        hostId,
        instanceId: 'remote-parent'
      })
      const localChild = { ...child, hostId: 'local' as const, instanceId: 'local-child' }
      const localParent = { ...parent, hostId: 'local' as const, instanceId: 'local-parent' }
      state.repos = [repo('local'), repo(hostId)]
      state.worktreesByRepo = { repo: [localChild, localParent, child, parent] }
      const rows = [localChild, localParent, child, parent].map(row)
      const dragSessionRef: { current: WorktreeSidebarDragSession | null } = { current: null }
      const captured: { current?: ReturnType<typeof useWorktreeLineageDropCommit> } = {}
      function Harness() {
        captured.current = useWorktreeLineageDropCommit({
          rows,
          dragSessionRef,
          repoMap: new Map(state.repos.map((repo) => [repo.id, repo])),
          worktreeMap: new Map(),
          worktreeLineageById: {},
          worktreeDragGroups: []
        })
        return null
      }
      renderToStaticMarkup(<Harness />)
      dragSessionRef.current = {
        sourceRowKey: row(child).rowKey,
        draggingWorktreeId: child.id,
        sourceGroupKey: 'all',
        draggedIds: [child.id],
        reorderDraggedIds: [child.id],
        reorderUnitDraggedIds: [child.id],
        rects: [],
        grab: null,
        anchor: null
      }
      const target = {
        status: null,
        isPinDrop: false,
        lineageParentId: parent.id,
        lineageParentRowKey: row(parent).rowKey
      }
      expect(captured.current?.getEligibleLineageDropTarget(target, [child.id])).toEqual(target)
      expect(captured.current?.commitWorktreeLineageParentDrop([child.id], parent.id)).toBe(true)
      expect(state.assignWorktreeParent).toHaveBeenCalledWith(child.id, {
        parentWorktreeId: parent.id,
        executionHostId: hostId
      })
      expect(
        captured.current?.getEligibleLineageDropTarget(
          { ...target, lineageParentRowKey: row(localParent).rowKey },
          [child.id]
        ).lineageParentId
      ).toBeNull()
    }
  )
})
