import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { mergeProjectCompatibilityForHostRepoChange } from '../repos/repo-catalog-identity'
import { isSameRepoRow } from '../repos/repo-host-identity'
import type { RepoSlice } from '../repos/repo-state'
import {
  notifyProjectGroupOnOtherHost,
  notifyProjectMoveFailed
} from './project-group-mutation-toasts'
import { isProjectGroupJoinableFromCatalog } from './project-group-owner-routing'

export async function executeMoveProjectToGroup(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1],
  project: Parameters<RepoSlice['moveProjectToGroup']>[0],
  groupId: Parameters<RepoSlice['moveProjectToGroup']>[1],
  order: Parameters<RepoSlice['moveProjectToGroup']>[2]
): ReturnType<RepoSlice['moveProjectToGroup']> {
  try {
    const repo = get().repos.find((candidate) => isSameRepoRow(candidate, project))
    const repoHostId = repo ? getRepoExecutionHostId(repo) : null
    const target = repoHostId ? ipcOrRuntimeTargetForHostId(repoHostId) : null
    if (!repo || !repoHostId || !target) {
      notifyProjectMoveFailed()
      return false
    }
    if (groupId && !isProjectGroupJoinableFromCatalog(get().projectGroups, groupId, target)) {
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
      notifyProjectMoveFailed()
      return false
    }
    const ownedMoved = adoptFromEndpoint(target, { kind: 'repo', row: moved })
    const movedHostId = getRepoExecutionHostId(ownedMoved)
    set((s) => {
      const nextRepos = s.repos.map((candidate) =>
        isSameRepoRow(candidate, repo) ? ownedMoved : candidate
      )
      return {
        repos: nextRepos,
        ...mergeProjectCompatibilityForHostRepoChange({
          previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
          nextRepos,
          hostId: movedHostId
        }),
        folderWorkspacePathStatuses: {}
      }
    })
    // Why: hosts store an unknown group id as "no group" and still return the row (#13699).
    if (groupId && (moved.projectGroupId ?? null) !== groupId) {
      notifyProjectGroupOnOtherHost()
      return false
    }
    return true
  } catch (err) {
    console.error('Failed to move repo to group:', err)
    notifyProjectMoveFailed()
    return false
  }
}
