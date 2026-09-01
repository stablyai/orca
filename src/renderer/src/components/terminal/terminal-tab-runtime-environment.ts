import type { AppState } from '@/store/types'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'

type TerminalTabRuntimeEnvironmentState = Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>

export type TerminalTabRuntimeEnvironment =
  | { kind: 'none' }
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'conflict' }

/** Resolves a terminal tab's remote owner only when all live PTY bindings agree. */
export function resolveTerminalTabRuntimeEnvironment(
  state: TerminalTabRuntimeEnvironmentState,
  worktreeId: string,
  terminalTabId: string
): TerminalTabRuntimeEnvironment {
  const tab = state.tabsByWorktree[worktreeId]?.find((entry) => entry.id === terminalTabId)
  const ptyIds = [tab?.ptyId, ...(state.ptyIdsByTabId?.[terminalTabId] ?? [])]
  let ownerEnvironmentId: string | null = null
  for (const ptyId of ptyIds) {
    const environmentId = ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
    if (!environmentId) {
      continue
    }
    if (ownerEnvironmentId && ownerEnvironmentId !== environmentId) {
      return { kind: 'conflict' }
    }
    ownerEnvironmentId = environmentId
  }
  return ownerEnvironmentId
    ? { kind: 'runtime', environmentId: ownerEnvironmentId }
    : { kind: 'none' }
}
