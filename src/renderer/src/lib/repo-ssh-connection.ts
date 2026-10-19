import {
  selectRuntimeAwareSshStatus,
  type RuntimeAwareSshStatusState
} from '@/store/slices/runtime-environment-ssh-selectors'
import { connectRuntimeEnvironmentSshTarget } from '@/runtime/runtime-environment-ssh-state'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

/** The SSH target holding a repo's files; `environmentId` is the paired server that owns it. */
export type RepoSshConnection = { environmentId: string | null; targetId: string }

type RepoSshFields = Pick<Repo, 'connectionId' | 'executionHostId'>

export function getRepoSshConnection(repo: RepoSshFields): RepoSshConnection | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    const targetId = getRepoSshConnectionId(repo)
    return targetId ? { environmentId: host.environmentId, targetId } : null
  }
  return repo.connectionId ? { environmentId: null, targetId: repo.connectionId } : null
}

/**
 * The target and status that gate creating a workspace in a repo. A server's own target is read
 * from that server's state, never this client's map (#25887). When this client cannot verify it
 * (server unreachable or not hydrated) nothing is gated here: the server owns the answer.
 */
export function selectRepoSshGateInput(
  state: RuntimeAwareSshStatusState,
  repo: RepoSshFields
): { connectionId: string | null; status: SshConnectionStatus | null } {
  const connection = getRepoSshConnection(repo)
  if (!connection) {
    return { connectionId: null, status: null }
  }
  if (connection.environmentId === null) {
    return {
      connectionId: connection.targetId,
      status: state.sshConnectionStates.get(connection.targetId)?.status ?? null
    }
  }
  const status = selectRuntimeAwareSshStatus(state, connection.environmentId, connection.targetId)
  return status === null
    ? { connectionId: null, status: null }
    : { connectionId: connection.targetId, status }
}

/** Connects the target on whichever machine owns it; a server's target is never dialed here. */
export async function connectRepoSshConnection(connection: RepoSshConnection): Promise<void> {
  if (connection.environmentId !== null) {
    await connectRuntimeEnvironmentSshTarget(connection.environmentId, connection.targetId)
    return
  }
  await window.api.ssh.connect({ targetId: connection.targetId })
}
