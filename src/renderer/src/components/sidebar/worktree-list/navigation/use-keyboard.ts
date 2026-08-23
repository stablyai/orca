import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy, WorktreeGroupBy } from '../grouping/row-types'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import type { RenderRow } from '../listing/render-row'
import { getCyclableWorktrees, resolveCycledWorktreeId } from '../../worktree-keyboard-cycle'
import { findPreferredRenderRowIndexForWorktreeIdentity } from './render-row-lookup'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  buildSidebarProjectNavigationOrder,
  getActiveProjectKey,
  selectProjectNavigationTarget
} from '../../project-navigation'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm's hidden input textarea isn't a real text field; treating it as one would block sidebar shortcuts.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

export function useWorktreeListKeyboardNavigation(args: {
  rows: HostSectionRow[]
  renderRows: RenderRow[]
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repoMap: Map<string, Repo>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  scrollRef: React.RefObject<HTMLDivElement | null>
  activeModal: string
  markDirectScrollInput: () => void
}) {
  const {
    rows,
    renderRows,
    groupBy,
    worktrees,
    folderWorkspaces,
    repoMap,
    prCache,
    workspaceStatuses,
    projectGroups,
    projectGrouping,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy,
    virtualizer,
    scrollRef,
    activeModal,
    markDirectScrollInput
  } = args
  const keybindings = useAppStore((s) => s.keybindings)
  const settings = useAppStore((s) => s.settings)
  const lastVisitedAtByWorktreeId = useAppStore((s) => s.lastVisitedAtByWorktreeId)

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: cycle over the rows the sidebar actually rendered — collapsing a group
      // means "not now", and a rebuilt near-copy would drift from what is on screen
      // (host sections, pinned placement, folder workspaces).
      const worktrees = getCyclableWorktrees(rows, pinnedDisplayPolicy)
      const worktreeIdentities = worktrees.map(getWorktreeHostIdentity)
      const nextWorktreeIdentity = resolveCycledWorktreeId({
        worktreeIds: worktreeIdentities,
        activeWorktreeId: activeWorktreeId
          ? composeWorktreeHostIdentity(
              activeWorkspaceExecutionHostId ?? undefined,
              activeWorktreeId
            )
          : null,
        direction
      })
      if (nextWorktreeIdentity === null) {
        return
      }
      const nextWorktree = worktrees.find(
        (worktree) => getWorktreeHostIdentity(worktree) === nextWorktreeIdentity
      )
      if (!nextWorktree) {
        return
      }

      // Why: keyboard cycling is real navigation; route through the activation helper that records history.
      activateAndRevealWorktree(
        nextWorktree.id,
        nextWorktree.hostId ? { executionHostId: nextWorktree.hostId } : {}
      )

      const rowIndex = findPreferredRenderRowIndexForWorktreeIdentity(
        renderRows,
        nextWorktree,
        pinnedDisplayPolicy
      )
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [
      rows,
      renderRows,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      virtualizer,
      pinnedDisplayPolicy
    ]
  )

  const navigateProject = useCallback(
    (direction: 'up' | 'down') => {
      const order = buildSidebarProjectNavigationOrder({
        rows,
        groupBy,
        worktrees,
        folderWorkspaces,
        repoMap,
        prCache,
        workspaceStatuses,
        settings,
        projectGroups,
        projectGrouping
      })
      const target = selectProjectNavigationTarget({
        ...order,
        activeProjectKey: getActiveProjectKey(
          order,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        ),
        activeWorktreeId,
        activeWorkspaceExecutionHostId,
        lastVisitedAtByWorktreeId,
        direction
      })
      if (!target) {
        return
      }

      const targetScope = parseWorkspaceKey(target.id)
      if (targetScope?.type === 'folder') {
        activateAndRevealFolderWorkspace(targetScope.folderWorkspaceId, {
          executionHostId: target.hostId
        })
      } else {
        activateAndRevealWorktree(target.id, { executionHostId: target.hostId })
      }
      const rowIndex = findPreferredRenderRowIndexForWorktreeIdentity(
        renderRows,
        target,
        pinnedDisplayPolicy
      )
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [
      rows,
      groupBy,
      worktrees,
      folderWorkspaces,
      repoMap,
      prCache,
      workspaceStatuses,
      settings,
      projectGroups,
      projectGrouping,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      lastVisitedAtByWorktreeId,
      renderRows,
      pinnedDisplayPolicy,
      virtualizer
    ]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModal !== 'none' || isEditableTarget(e.target)) {
        return
      }

      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('sidebar.focusWorktreeList', e, platform, keybindings)) {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      const direction = keybindingMatchesAction('worktree.navigateUp', e, platform, keybindings)
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings)
          ? 'down'
          : null
      if (direction) {
        markDirectScrollInput()
        navigateWorktree(direction)
        e.preventDefault()
        return
      }

      const projectDirection = keybindingMatchesAction(
        'project.navigatePrevious',
        e,
        platform,
        keybindings
      )
        ? 'up'
        : keybindingMatchesAction('project.navigateNext', e, platform, keybindings)
          ? 'down'
          : null
      if (projectDirection) {
        markDirectScrollInput()
        navigateProject(projectDirection)
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [
    activeModal,
    keybindings,
    markDirectScrollInput,
    navigateProject,
    navigateWorktree,
    scrollRef
  ])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.target !== e.currentTarget) {
          return
        }
        markDirectScrollInput()
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      } else if (e.key === 'Enter') {
        const helper = document.querySelector(
          '.xterm-helper-textarea'
        ) as HTMLTextAreaElement | null
        if (helper) {
          helper.focus()
        }
        e.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput, navigateWorktree]
  )

  return { handleContainerKeyDown }
}
