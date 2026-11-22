import { useMemo } from 'react'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  getRepoSshConnection,
  selectRepoSshGateInput
} from '@/lib/workspace/catalog/repo-ssh-connection'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../shared/repository/repo-types'

type Gate = ReturnType<typeof selectRepoSshGateInput>
const NO_GATE: Gate = { connectionId: null, status: null }

function createRepoSshGateSelector(repo: Pick<Repo, 'connectionId' | 'executionHostId'>) {
  const connection = getRepoSshConnection(repo)
  let initialized = false
  let owner: ReturnType<RuntimeStatuses['get']>
  let entry: ReturnType<AppState['sshConnectionStates']['get']>
  let hydrated: boolean | undefined
  let result = NO_GATE
  return (state: AppState, statuses: RuntimeStatuses): Gate => {
    if (!connection) {
      return NO_GATE
    }
    const nextOwner =
      connection.environmentId === null ? undefined : statuses.get(connection.environmentId)
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
    const next = selectRepoSshGateInput(
      {
        sshConnectionStates: state.sshConnectionStates,
        sshStateByEnvironment: state.sshStateByEnvironment
      },
      statuses,
      repo
    )
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
  return useAppStoreWithHostStatuses(select)
}
