import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getRepoSshConnection, selectRepoSshGateInput } from '@/lib/repo-ssh-connection'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'

type Gate = ReturnType<typeof selectRepoSshGateInput>
const NO_GATE: Gate = { connectionId: null, status: null }

function createRepoSshGateSelector(repo: Pick<Repo, 'connectionId' | 'executionHostId'>) {
  const connection = getRepoSshConnection(repo)
  let initialized = false
  let owner: ReturnType<AppState['runtimeStatusByEnvironmentId']['get']>
  let entry: ReturnType<AppState['sshConnectionStates']['get']>
  let hydrated: boolean | undefined
  let result = NO_GATE
  return (state: AppState): Gate => {
    if (!connection) {
      return NO_GATE
    }
    const nextOwner =
      connection.environmentId === null
        ? undefined
        : state.runtimeStatusByEnvironmentId.get(connection.environmentId)
    const bucket =
      connection.environmentId === null
        ? undefined
        : state.sshStateByEnvironment.get(connection.environmentId)
    const nextHydrated = bucket?.targetsHydrated
    const nextEntry =
      connection.environmentId === null
        ? state.sshConnectionStates.get(connection.targetId)
        : bucket?.connectionStates.get(connection.targetId)
    if (initialized && owner === nextOwner && hydrated === nextHydrated && entry === nextEntry) {
      return result
    }
    initialized = true
    owner = nextOwner
    hydrated = nextHydrated
    entry = nextEntry
    const next = selectRepoSshGateInput(state, repo)
    if (result.connectionId !== next.connectionId || result.status !== next.status) {
      result = next
    }
    return result
  }
}

export function useRepoSshGate(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): Gate {
  const { connectionId, executionHostId } = repo
  const select = useMemo(
    () => createRepoSshGateSelector({ connectionId, executionHostId }),
    [connectionId, executionHostId]
  )
  return useAppStore(select)
}
