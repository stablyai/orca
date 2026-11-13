import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { WorkspaceHookOwner } from '../../../../../../shared/workspace-hook-owner'
import type { RuntimeCapability } from '../../../../../../shared/protocol-version'
import { WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

export type FolderSetupSupport = 'supported' | 'unsupported' | 'pending'

type FolderSetupHost =
  | { kind: 'known'; supported: boolean }
  | { kind: 'runtime'; environmentId: string }

function folderSetupHost(repo: WorkspaceHookOwner | null | undefined): FolderSetupHost {
  if (!repo || !isFolderRepo(repo)) {
    return { kind: 'known', supported: true }
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  // An unserved SSH folder runs no hooks; its files aren't on a host Orca runs scripts on.
  if (host?.kind === 'ssh') {
    return { kind: 'known', supported: false }
  }
  return host?.kind === 'runtime'
    ? { kind: 'runtime', environmentId: host.environmentId }
    : { kind: 'known', supported: true }
}

type FolderSetupObservation = {
  answer: boolean | undefined
  listeners: Set<() => void>
  probe?: Promise<boolean>
}

// Active readers own answers; the runtime compatibility cache handles reuse after they leave.
const folderSetupObservations = new Map<string, FolderSetupObservation>()

function probeFolderSetup(
  environmentId: string,
  capability: RuntimeCapability = WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY
): Promise<boolean> {
  const observation = folderSetupObservations.get(`${capability}:${environmentId}`)
  if (observation?.probe) {
    return observation.probe
  }
  const probe = runtimeEnvironmentSupportsCapability(environmentId, capability)
    .then((supported) => {
      if (
        observation &&
        folderSetupObservations.get(`${capability}:${environmentId}`) === observation &&
        observation.answer !== supported
      ) {
        observation.answer = supported
        observation.listeners.forEach((listener) => listener())
      }
      return supported
    })
    .finally(() => {
      if (observation?.probe === probe) {
        observation.probe = undefined
      }
    })
  if (observation) {
    observation.probe = probe
  }
  return probe
}

/** Folder setup runs only on hosts that report it; older hosts would save scripts that never run. Rejects when the host can't answer. */
export function resolveFolderSetupSupported(
  repo: WorkspaceHookOwner | null | undefined,
  capability: RuntimeCapability = WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY
): Promise<boolean> {
  const host = folderSetupHost(repo)
  return host.kind === 'known'
    ? Promise.resolve(host.supported)
    : probeFolderSetup(host.environmentId, capability)
}

export function useFolderSetupSupport(
  repo: WorkspaceHookOwner | null | undefined,
  capability: RuntimeCapability = WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY
): FolderSetupSupport {
  const host = folderSetupHost(repo)
  const environmentId = host.kind === 'runtime' ? host.environmentId : null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!environmentId) {
        return () => {}
      }
      let observation = folderSetupObservations.get(`${capability}:${environmentId}`)
      if (!observation) {
        observation = { answer: undefined, listeners: new Set() }
        folderSetupObservations.set(`${capability}:${environmentId}`, observation)
      }
      observation.listeners.add(listener)
      return () => {
        observation.listeners.delete(listener)
        if (
          observation.listeners.size === 0 &&
          folderSetupObservations.get(`${capability}:${environmentId}`) === observation
        ) {
          folderSetupObservations.delete(`${capability}:${environmentId}`)
        }
      }
    },
    [environmentId, capability]
  )
  const answer = useSyncExternalStore(subscribe, () =>
    environmentId
      ? folderSetupObservations.get(`${capability}:${environmentId}`)?.answer
      : undefined
  )
  useEffect(() => {
    // Re-asked on mount so an in-place host upgrade shows; a failure stays pending for Create to retry.
    if (environmentId) {
      probeFolderSetup(environmentId, capability).catch(() => {})
    }
  }, [environmentId, capability])
  if (host.kind === 'known') {
    return host.supported ? 'supported' : 'unsupported'
  }
  if (answer === undefined) {
    return 'pending'
  }
  return answer ? 'supported' : 'unsupported'
}
