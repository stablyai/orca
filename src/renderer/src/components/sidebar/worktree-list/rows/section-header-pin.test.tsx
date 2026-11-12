// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { INITIAL_REPO_DRAG_STATE } from '../drag/project-header-drag-contract'
import { INITIAL_PROJECT_GROUP_DRAG_STATE } from '../drag/project-group-header-drag-contract'
import { repo } from '../grouping/worktree-list-groups-test-fixtures'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'
import {
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'
import { renderWorktreeSectionHeaderRow, type SectionHeaderRowContext } from './SectionHeader'

afterEach(() => {
  cleanup()
})

function makeProjectActions(
  overrides: Partial<RepoHeaderProjectActions> = {}
): RepoHeaderProjectActions {
  return {
    getWorktreeVisibilityDefaults: () => undefined,
    onOpenRepoSettings: vi.fn(),
    onOpenWorktreeVisibility: vi.fn(),
    onCreateGroupFromRepo: vi.fn(),
    onMoveProjectToGroup: vi.fn(),
    onRemoveProjectFromGroup: vi.fn(),
    onRemoveProject: vi.fn(),
    onCreateForRepo: vi.fn(),
    ...overrides
  }
}

function makeHeaderContext(
  overrides: Partial<SectionHeaderRowContext> = {}
): SectionHeaderRowContext {
  return {
    groupBy: 'repo',
    collapsedGroups: new Set(),
    workspaceStatuses: [],
    projectGroups: [],
    highlightedRevealRowKey: null,
    dragOverStatus: null,
    pinDragOver: false,
    getCachedFolderWorkspacePathStatus: () => null,
    toggleGroupWithScrollAnchor: vi.fn(),
    headerDrag: {
      rootProjectHeaderCountByOccurrenceKey: new Map(),
      rootProjectHeaderSectionEndByKey: new Map(),
      rootProjectHeaderKeys: undefined,
      canReorderRepoHeaders: false,
      canDragRepoHeaders: false,
      canDragProjectHeader: () => false,
      canReorderProjectGroupHeaders: false,
      canDragProjectGroupHeader: () => false,
      moveProjectGroupToParent: vi.fn(),
      orderedHostIds: [],
      hostDrag: {
        state: { draggingHostId: null, dropIndex: null, dropIndicatorY: null },
        onHandlePointerDown: vi.fn()
      },
      repoDrag: { state: INITIAL_REPO_DRAG_STATE, onHandlePointerDown: vi.fn() },
      projectGroupDrag: { state: INITIAL_PROJECT_GROUP_DRAG_STATE, onHandlePointerDown: vi.fn() },
      sidebarRepoHeaderIdsByBucket: new Map(),
      sidebarProjectGroupHeaderIdsByBucket: new Map(),
      repoHeaderIndexByRepoId: new Map(),
      repoHeaderBucketByRepoId: new Map(),
      projectGroupHeaderIndexByGroupId: new Map(),
      projectGroupHeaderBucketByGroupId: new Map(),
      repoHeaderSectionEndByRepoId: new Map(),
      repoHeaderSectionEndIndexByRepoId: new Map(),
      projectGroupHeaderSectionEndByGroupId: new Map(),
      projectGroupHeaderSectionEndIndexByGroupId: new Map(),
      headerSectionEndByRowIndex: new Map(),
      headerSectionEndIndexByRowIndex: new Map()
    },
    projectActions: makeProjectActions(),
    onRenameProjectGroup: vi.fn(),
    onDeleteProjectGroup: vi.fn(),
    onCreateFolderWorkspace: vi.fn(),
    onWorkspaceStatusDragOver: vi.fn(),
    onWorkspaceStatusDragLeave: vi.fn(),
    onWorkspacePinDragOver: vi.fn(),
    onWorkspacePinDragLeave: vi.fn(),
    onWorkspaceStatusDrop: vi.fn(),
    ...overrides
  }
}

describe('SectionHeader & header menu pinning', () => {
  it('unpins all host registrations of a localized 3-host project header without toggling collapse', () => {
    const localTwin: Repo = { ...repo, id: 'repo-alpha', displayName: 'Alpha', isPinned: false }
    const remoteTwin: Repo = {
      ...localTwin,
      path: '/srv/alpha',
      executionHostId: 'runtime:builder',
      isPinned: true
    }
    const stagingTwin: Repo = {
      ...localTwin,
      path: '/stg/alpha',
      executionHostId: 'runtime:staging',
      isPinned: false
    }
    const onTogglePinProject = vi.fn()
    const toggleGroupWithScrollAnchor = vi.fn()
    const ctx = makeHeaderContext({
      toggleGroupWithScrollAnchor,
      projectActions: makeProjectActions({ onTogglePinProject })
    })
    // Simulate a post-localizeProjectHeader row on the anchor ('local') host: hostRepos is stripped,
    // repo === anchorRepo === localTwin (isPinned: false), while pinTargetRepos retains all 3 hosts.
    const row: GroupHeaderRow = {
      type: 'header',
      key: 'project:alpha',
      label: 'Alpha',
      count: 1,
      icon: { kind: 'project' },
      hostId: 'local',
      repo: localTwin,
      anchorRepo: localTwin,
      pinTargetRepos: [localTwin, remoteTwin, stagingTwin]
    }

    const view = render(
      <TooltipProvider>
        {renderWorktreeSectionHeaderRow({
          ctx,
          row,
          vItem: { key: 'project:alpha', index: 0, start: 0, size: 28, end: 28, lane: 0 },
          isActiveStickyHeader: false,
          hasStickyHost: false,
          hasHeaderTopSpacing: false,
          measureVirtualRowElement: vi.fn()
        })}
      </TooltipProvider>
    )

    fireEvent.click(view.getByRole('button', { name: 'Unpin Alpha' }))

    expect(onTogglePinProject).toHaveBeenCalledTimes(1)
    expect(onTogglePinProject).toHaveBeenCalledWith([localTwin, remoteTwin, stagingTwin], false)
    expect(toggleGroupWithScrollAnchor).not.toHaveBeenCalled()
  })

  it('unpins a pinned manual ProjectGroup header with its owner hostId and hides the button when unpinned', () => {
    const manualPinnedGroup: ProjectGroup = {
      ...createProjectGroup({
        name: 'Core Group',
        createdFrom: 'manual',
        tabOrder: 0
      }),
      id: 'g-manual',
      executionHostId: 'runtime:builder',
      isPinned: true
    }
    const onTogglePinProjectGroup = vi.fn()
    const toggleGroupWithScrollAnchor = vi.fn()
    const ctx = makeHeaderContext({
      projectGroups: [manualPinnedGroup],
      toggleGroupWithScrollAnchor,
      onTogglePinProjectGroup
    })
    const pinnedRow: GroupHeaderRow = {
      type: 'header',
      key: 'project-group:g-manual',
      label: 'Core Group',
      count: 1,
      icon: { kind: 'project' },
      projectGroup: manualPinnedGroup
    }

    const view = render(
      <TooltipProvider>
        {renderWorktreeSectionHeaderRow({
          ctx,
          row: pinnedRow,
          vItem: { key: 'project-group:g-manual', index: 0, start: 0, size: 28, end: 28, lane: 0 },
          isActiveStickyHeader: false,
          hasStickyHost: false,
          hasHeaderTopSpacing: false,
          measureVirtualRowElement: vi.fn()
        })}
      </TooltipProvider>
    )

    fireEvent.click(view.getByRole('button', { name: 'Unpin Core Group' }))
    expect(onTogglePinProjectGroup).toHaveBeenCalledWith('g-manual', false, 'runtime:builder')
    expect(toggleGroupWithScrollAnchor).not.toHaveBeenCalled()

    view.rerender(
      <TooltipProvider>
        {renderWorktreeSectionHeaderRow({
          ctx,
          row: { ...pinnedRow, projectGroup: { ...manualPinnedGroup, isPinned: false } },
          vItem: { key: 'project-group:g-manual', index: 0, start: 0, size: 28, end: 28, lane: 0 },
          isActiveStickyHeader: false,
          hasStickyHost: false,
          hasHeaderTopSpacing: false,
          measureVirtualRowElement: vi.fn()
        })}
      </TooltipProvider>
    )
    expect(view.queryByRole('button', { name: 'Unpin Core Group' })).toBeNull()
  })

  it('toggles pin state from both ProjectGroupHeaderMenu (including manual groups) and RepoHeaderProjectActionsMenu', () => {
    const onTogglePinGroup = vi.fn()
    const groupMenu = render(
      <TooltipProvider>
        <ProjectGroupHeaderMenu
          groupId="g-manual"
          hostId="runtime:builder"
          label="Core Group"
          projectGroup={null}
          isPinned={true}
          onTogglePinGroup={onTogglePinGroup}
          onRename={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    )
    fireEvent.pointerDown(groupMenu.getByRole('button', { name: 'Group actions for Core Group' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(groupMenu.getByRole('menuitem', { name: 'Unpin group' }))
    expect(onTogglePinGroup).toHaveBeenCalledWith('g-manual', false, 'runtime:builder')

    cleanup()

    const targetRepo: Repo = { ...repo, id: 'r1', displayName: 'Beta', isPinned: false }
    const onTogglePinProject = vi.fn()
    const repoMenu = render(
      <TooltipProvider>
        <RepoHeaderProjectActionsMenu
          repo={targetRepo}
          label="Beta"
          projectGroups={[]}
          actions={makeProjectActions({ onTogglePinProject })}
        />
      </TooltipProvider>
    )
    fireEvent.pointerDown(repoMenu.getByRole('button', { name: 'Project actions for Beta' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(repoMenu.getByRole('menuitem', { name: 'Pin project' }))
    expect(onTogglePinProject).toHaveBeenCalledWith([targetRepo], true)
  })
})
