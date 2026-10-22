import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { RepoSlice } from '../repos/repo-state'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import {
  assertProjectHostSetupMutationRuntimeCapabilities,
  getProjectSetupRuntimeTarget
} from './project-host-routing'

/** Clones the project on its host, then sets that checkout up as the project's folder there. */
export async function setupProjectClone(
  get: Parameters<StateCreator<AppState>>[1],
  args: Parameters<RepoSlice['setupProjectClone']>[0]
): ReturnType<RepoSlice['setupProjectClone']> {
  try {
    const parsedHost = parseExecutionHostId(args.hostId)
    // Why: an SSH host clones only through its paired server; never fall back to this computer.
    if (parsedHost?.kind === 'ssh') {
      throw new Error(`SSH connection "${parsedHost.targetId}" not found or not connected`)
    }
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
    const message = err instanceof Error ? err.message : String(err)
    toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
      description: message,
      duration: ERROR_TOAST_DURATION
    })
    return null
  }
}
