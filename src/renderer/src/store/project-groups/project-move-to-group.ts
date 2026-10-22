import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'
import type { RepoSlice } from '../repos/repo-state'
import { mergeProjectCompatibilityForHostRepoChange } from '../repos/repo-catalog-identity'
import { isProjectGroupJoinableFromCatalog } from '../slices/project-group-owner-routing'
import { isSameRepoRow } from '../slices/repo-host-identity'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { mainCatalogShowsWrite } from '../main-project-catalog-writes'
import {
  selectProjectGroups,
  selectProjectHostSetups,
  selectProjects,
  selectRepos
} from '../project-catalog-selectors'
import { notifyProjectGroupOnOtherHost } from './project-group-other-host-notice'

/** Moves a project into a group (or out, with null) on the host that owns its row. */
export async function moveProjectToGroup(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1],
  ...[project, groupId, order]: Parameters<RepoSlice['moveProjectToGroup']>
): ReturnType<RepoSlice['moveProjectToGroup']> {
  try {
    const repo = selectRepos(get()).find((candidate) => isSameRepoRow(candidate, project))
    const repoHostId = repo ? getRepoExecutionHostId(repo) : null
    const target = repoHostId ? ipcOrRuntimeTargetForHostId(repoHostId) : null
    if (!repo || !repoHostId || !target) {
      return false
    }
    if (
      groupId &&
      !isProjectGroupJoinableFromCatalog(selectProjectGroups(get()), groupId, target)
    ) {
      notifyProjectGroupOnOtherHost()
      return false
    }
    const moved =
      target.kind === 'local'
        ? await window.api.projectGroups.moveProject({
            projectId: repo.id,
            groupId,
            order,
            hostId: repoHostId
          })
        : (
            await callRuntimeRpc<{ repo: Repo | null }>(
              target,
              'projectGroup.moveProject',
              // Why connectionId: the server's own twins differ only by their SSH target there.
              { repo: repo.id, groupId, order, connectionId: repo.connectionId ?? null },
              { timeoutMs: 15_000 }
            )
          ).repo
    if (!moved) {
      return false
    }
    const ownedMoved = adoptFromEndpoint(target, { kind: 'repo', row: moved })
    const movedHostId = getRepoExecutionHostId(ownedMoved)
    const shown =
      !ORCA_SIDEBAR_INPUTS_IS_MAIN ||
      (await mainCatalogShowsWrite(target, (catalog) =>
        catalog.repos.some(
          (candidate) =>
            isSameRepoRow(candidate, ownedMoved) &&
            (candidate.projectGroupId ?? null) === (ownedMoved.projectGroupId ?? null) &&
            candidate.projectGroupOrder === ownedMoved.projectGroupOrder
        )
      ))
    set((s) => {
      if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
        return { folderWorkspacePathStatuses: {} }
      }
      const nextRepos = selectRepos(s).map((candidate) =>
        isSameRepoRow(candidate, repo) ? ownedMoved : candidate
      )
      return {
        repos: nextRepos,
        ...mergeProjectCompatibilityForHostRepoChange({
          previous: {
            projects: selectProjects(s),
            projectHostSetups: selectProjectHostSetups(s)
          },
          nextRepos,
          hostId: movedHostId
        }),
        folderWorkspacePathStatuses: {}
      }
    })
    if (!shown) {
      return false
    }
    // Why: hosts store an unknown group id as "no group" and still return the row (#13699).
    if (groupId && (moved.projectGroupId ?? null) !== groupId) {
      notifyProjectGroupOnOtherHost()
      return false
    }
    return true
  } catch (err) {
    console.error('Failed to move repo to group:', err)
    return false
  }
}
