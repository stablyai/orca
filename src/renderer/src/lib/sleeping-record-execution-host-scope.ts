import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  getKnownExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

/**
 * Does this record's `--resume` locator belong to a different machine than the one the resume would
 * run on?
 *
 * A provider session id names a transcript in one machine's agent state directory, but nothing
 * else in the resume path is host-scoped: `worktreeId` is `repoId::path` with no host component
 * (shared/worktree/host-qualified-identity.ts), sleeping records are `'sleepingAgentKeyed'` so the
 * boot-time host-contention parking never arbitrates them and every partition's records merge into
 * one map, and `launchSleepingAgentSession` resolves its launch target from the *current* catalog.
 * A record captured on host A therefore reaches a launch on host B, which answers
 * `No conversation found with session ID`.
 *
 * Deliberately fails open. It reports only a positively-known disagreement about the machine,
 * because the alternative — refusing whenever the hosts cannot be compared — would strand every
 * legitimate resume whose capture predates the stamp.
 *
 * "Fail open" names a direction for THIS decision, never a house style, and the safe direction is
 * inverted a few files away. Here the destructive act is *attempting* a resume — a wrong one can
 * fork a transcript, which is unrecoverable, while a refusal keeps the record and the user can
 * resume by hand. So an unhydrated catalog must not be read as a host verdict. In
 * `workspace-session-terminal-buffers.ts` the destructive act is the opposite: declining to capture
 * loses the only scrollback copy, so an unknown repo is treated as remote. Same window, opposite
 * default, both correct. A reader pattern-matching one onto the other will get this backwards.
 *
 * The four unknowns this fails open on:
 *
 *  - `undefined` is "never stamped", not "local" (#9030 leaves SSH orphans unstamped).
 *  - `null` is "local **or** paired runtime": a `remote:<env>@@<handle>` PTY is stamped null too
 *    (agent-status-connection-ownership.ts), so null cannot rule a runtime host out — only an
 *    `ssh:` one, which is unambiguously another machine.
 *  - A current host of `runtime:*` is no evidence either way, because a paired client relabels its
 *    host's workspaces — including that host's own SSH ones — into its runtime namespace.
 *  - A current host of `null` is a catalog with no row for the worktree. The routing resolver
 *    answers `'local'` there, which is the right default for issuing an operation and would read
 *    here as a positive host — so the worktree form below asks the resolver that keeps the silence.
 */
export function agentResumeOriginNamesAnotherExecutionHost(
  originConnectionId: string | null | undefined,
  currentExecutionHostId: ExecutionHostId | null | undefined
): boolean {
  if (originConnectionId === undefined) {
    return false
  }
  const originTargetId = originConnectionId === null ? null : originConnectionId.trim()
  if (originTargetId === '') {
    return false
  }
  const currentHost = parseExecutionHostId(currentExecutionHostId)
  if (!currentHost || currentHost.kind === 'runtime') {
    return false
  }
  if (currentHost.kind === 'ssh') {
    return originTargetId === null || toSshExecutionHostId(originTargetId) !== currentHost.id
  }
  return originTargetId !== null
}

/** The worktree-scoped form the activation sweep asks, resolving the host from the catalog. */
export function sleepingRecordNamesAnotherExecutionHost(
  record: SleepingAgentSessionRecord,
  state: WorktreeRuntimeOwnerState
): boolean {
  return agentResumeOriginNamesAnotherExecutionHost(
    record.connectionId,
    getKnownExecutionHostIdForWorktree(state, record.worktreeId)
  )
}
