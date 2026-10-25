import type { Repo } from './repo-types'
import { getRepoSshConnectionId } from './execution-host'

/** SSH file owners use relay orca/orca.cmd, never the Linux desktop orca-ide rename. Resolve executionHostId over stale connectionId; runtime hosts are remote only with nested SSH. Local-PTY routing uses getSshTargetIdForExecutionHost; already-resolved launch connections need no re-derivation. */
export function repoIsRemote(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): boolean {
  return getRepoSshConnectionId(repo) !== null
}
