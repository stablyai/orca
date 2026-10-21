import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import type { TerminalPtyOwner } from '@/lib/terminal-worktree-route'

export type TerminalTeardownOwner =
  | { kind: 'resolved'; runtimeEnvironmentId: string | null }
  | { kind: 'refused'; reason: 'ambiguous_terminal_owner' }

/**
 * Which runtime host must stop these PTYs (`null`: none). When two hosts publish the worktree, each
 * `remote:<env>@@…` id names its own owner; a PTY that names none (or no PTY at all) can't be
 * attributed, so teardown is refused rather than treated as local.
 */
export function resolveTerminalTeardownOwner(
  worktreeOwner: TerminalPtyOwner,
  ptyIds: readonly string[]
): TerminalTeardownOwner {
  if (worktreeOwner.kind === 'runtime') {
    return { kind: 'resolved', runtimeEnvironmentId: worktreeOwner.environmentId }
  }
  if (worktreeOwner.kind === 'non-runtime') {
    return { kind: 'resolved', runtimeEnvironmentId: null }
  }
  // Why: with no bound PTY there is nothing to attribute, and the server may still run the agent.
  if (ptyIds.length === 0) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  const environmentIds = new Set<string>()
  for (const ptyId of ptyIds) {
    if (!isRemoteRuntimePtyId(ptyId)) {
      continue
    }
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId?.trim()
    if (!environmentId) {
      return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
    }
    environmentIds.add(environmentId)
  }
  // Why: a stop split across runtimes can half-succeed, and no rollback is right for both halves.
  if (environmentIds.size > 1) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  return { kind: 'resolved', runtimeEnvironmentId: [...environmentIds][0] ?? null }
}
