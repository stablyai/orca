import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import {
  assertNotSshProjectHost,
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget
} from './project-host-routing'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { toastProjectAddFailure } from './project-add-failure-toast'

export function createProjectHostCloneAction(
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['setupProjectClone'] {
  return async (args) => {
    try {
      assertNotSshProjectHost(get(), args.hostId)
      const target = getProjectSetupRuntimeTarget(args.hostId)
      await assertProjectHostSetupMutationRuntimeCapabilities(target)
      const repo =
        target.kind === 'local'
          ? await window.api.repos.clone({
              url: args.url,
              destination: args.destination
            })
          : (
              await callRuntimeRpc<{ repo: Repo }>(
                target,
                'repo.clone',
                {
                  url: args.url,
                  destination: args.destination
                },
                { timeoutMs: 10 * 60_000 }
              )
            ).repo
      return await get().setupProjectExistingFolder({
        projectId: args.projectId,
        hostId: args.hostId,
        path: repo.path,
        kind: 'git',
        displayName: args.displayName,
        setupMethod: 'cloned'
      })
    } catch (err) {
      console.error('Failed to clone project on host:', err)
      toastProjectAddFailure(err)
      return null
    }
  }
}
