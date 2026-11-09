import { useEffect, useState } from 'react'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

export type FolderSetupSupport = 'supported' | 'unsupported' | 'pending'

type FolderSetupHost =
  | { kind: 'known'; supported: boolean }
  | { kind: 'runtime'; environmentId: string }

function folderSetupHost(repo: Repo | null | undefined): FolderSetupHost {
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

function probeFolderSetup(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY
  )
}

/** Folder setup runs only on hosts that report it; older hosts would save scripts that never run. Rejects when the host can't answer. */
export function resolveFolderSetupSupported(repo: Repo | null | undefined): Promise<boolean> {
  const host = folderSetupHost(repo)
  return host.kind === 'known'
    ? Promise.resolve(host.supported)
    : probeFolderSetup(host.environmentId)
}

export function useFolderSetupSupport(repo: Repo | null | undefined): FolderSetupSupport {
  const host = folderSetupHost(repo)
  const environmentId = host.kind === 'runtime' ? host.environmentId : null
  const [probe, setProbe] = useState<{ environmentId: string; supported: boolean } | null>(null)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let cancelled = false
    // A failed probe stays pending so Create re-asks instead of treating it as unsupported.
    probeFolderSetup(environmentId).then(
      (supported) => {
        if (!cancelled) {
          setProbe({ environmentId, supported })
        }
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [environmentId])
  if (host.kind === 'known') {
    return host.supported ? 'supported' : 'unsupported'
  }
  if (probe?.environmentId !== host.environmentId) {
    return 'pending'
  }
  return probe.supported ? 'supported' : 'unsupported'
}
