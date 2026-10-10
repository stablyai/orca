import { useMemo } from 'react'
import { buildImportedWorktreesCardCandidates } from '@/components/sidebar/imported-worktrees-card-candidates'
import {
  hasCmdJProjectSearchCandidates,
  searchCmdJProjectResults
} from '@/components/cmd-j/palette-project-results'
import {
  buildCmdJActionResults,
  buildCmdJSettingsResults
} from '@/components/cmd-j/palette-results'
import { getCmdJQuickActions } from '@/components/cmd-j/quick-actions'
import { buildPluginQuickActions } from '@/components/cmd-j/plugin-quick-actions'
import type { ProjectTargetPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

type WorktreeJumpPaletteProjectTargetsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteFilter &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'>

export function useWorktreeJumpPaletteProjectTargets({
  settingsSections,
  pluginCommands,
  allWorktrees,
  repos,
  worktreesByRepo,
  detectedWorktreesByRepo,
  worktreeVisibilityDefaultsByHost,
  pendingWorktreeCreations,
  projectGroups,
  projects,
  projectHostSetups,
  hasQuery,
  deferredQuery,
  filterPredicate,
  groupHostIdByGroupId,
  defaultHostId
}: WorktreeJumpPaletteProjectTargetsInput) {
  const settingsResults = useMemo(
    () => buildCmdJSettingsResults(settingsSections),
    [settingsSections]
  )
  const actionResults = useMemo(
    () =>
      buildCmdJActionResults([
        ...getCmdJQuickActions(),
        ...buildPluginQuickActions(pluginCommands)
      ]),
    [pluginCommands]
  )
  const renderableProjectRepoIds = useMemo(() => {
    const ids = new Set<string>()
    for (const worktree of allWorktrees) {
      if (!worktree.isArchived) {
        ids.add(worktree.repoId)
      }
    }
    for (const repo of repos) {
      if ((worktreesByRepo[repo.id]?.length ?? 0) === 0) {
        ids.add(repo.id)
      }
    }
    for (const repoId of buildImportedWorktreesCardCandidates({
      repos,
      detectedWorktreesByRepo,
      visibilityDefaultsByHost: worktreeVisibilityDefaultsByHost
    }).keys()) {
      ids.add(repoId)
    }
    for (const creation of Object.values(pendingWorktreeCreations)) {
      ids.add(creation.request.repoId)
    }
    return ids
  }, [
    allWorktrees,
    detectedWorktreesByRepo,
    pendingWorktreeCreations,
    repos,
    worktreeVisibilityDefaultsByHost,
    worktreesByRepo
  ])
  const hasAnyProjectSearchCandidates = useMemo(
    () =>
      hasCmdJProjectSearchCandidates({
        projectGroups,
        repos,
        projects,
        projectHostSetups,
        renderableRepoIds: renderableProjectRepoIds
      }),
    [projectGroups, projectHostSetups, projects, renderableProjectRepoIds, repos]
  )
  const projectTargetItems = useMemo<ProjectTargetPaletteItem[]>(
    () =>
      hasQuery
        ? searchCmdJProjectResults({
            query: deferredQuery,
            projectGroups,
            repos,
            projects,
            projectHostSetups,
            renderableRepoIds: renderableProjectRepoIds
          })
            .filter((result) => {
              if (!filterPredicate) {
                return true
              }
              return result.kind === 'project'
                ? filterPredicate.matchesProjectRowKey(result.rowKey)
                : filterPredicate.matchesGroupHostId(
                    groupHostIdByGroupId.get(result.id.slice('project-group:'.length)) ??
                      defaultHostId
                  )
            })
            .map((result) => ({ id: result.id, type: 'project-target' as const, result }))
        : [],
    [
      deferredQuery,
      defaultHostId,
      filterPredicate,
      groupHostIdByGroupId,
      hasQuery,
      projectGroups,
      projectHostSetups,
      projects,
      renderableProjectRepoIds,
      repos
    ]
  )
  return {
    settingsResults,
    actionResults,
    hasAnyProjectSearchCandidates,
    projectTargetItems
  }
}

export type WorktreeJumpPaletteProjectTargets = ReturnType<
  typeof useWorktreeJumpPaletteProjectTargets
>
