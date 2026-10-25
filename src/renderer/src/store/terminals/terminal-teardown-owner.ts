import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import type { TerminalPtyOwner } from '@/lib/terminal-worktree-route'

export type TerminalTeardownOwner =
  | { kind: 'resolved'; runtimeEnvironmentId: string | null }
  | { kind: 'refused'; reason: 'ambiguous_terminal_owner' }

/** Resolve the stopping host (null: none); with host twins, each remote:<env>@@… PTY must identify one owner or teardown refuses, including unbound tabs. */
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
  // No bound PTY proves no owner; the server may still run the agent.
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
  // A cross-runtime stop can half-succeed with no valid rollback for both halves.
  if (environmentIds.size > 1) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  return { kind: 'resolved', runtimeEnvironmentId: [...environmentIds][0] ?? null }
}
