import type { Repo } from './repo-types'
import { getRepoSshConnectionId } from './execution-host'

/**
 * Why: a repo reached over SSH runs the Orca CLI through the relay shim, which is always deployed
 * as plain `orca` (Unix) / `orca.cmd` (Windows). The Linux-only `orca-ide` rename — which exists
 * solely to avoid shadowing the GNOME Orca screen reader on a local desktop — must not be applied
 * to those remotes, or `orca-ide claude-teams` lands on a PATH where it does not exist.
 *
 * The question is "does an SSH target hold this row's files", not "what may this client dial", so
 * it resolves the execution host instead of reading the raw `connectionId` field. SSH ownership has
 * two spellings and the raw read is wrong in both directions:
 *
 *   - a row carrying only `executionHostId: 'ssh:<target>'` reads as local and gets the `orca-ide`
 *     rename it cannot resolve on the remote;
 *   - a row that declares itself `local` while a stale `connectionId` survives reads as remote and
 *     loses the rename it needs on a Linux desktop.
 *
 * `runtime:<env>` keeps its nested SSH target (that machine reaches the files through its own relay
 * shim), while a runtime host with no nested target is a full Orca install and stays false — as do
 * WSL and local. Callers routing a client-local PTY want `getSshTargetIdForExecutionHost` instead;
 * callers that already hold a resolved launch connection should read that, not re-derive here.
 */
export function repoIsRemote(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): boolean {
  return getRepoSshConnectionId(repo) !== null
}
