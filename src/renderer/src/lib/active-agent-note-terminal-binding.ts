import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import type { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { captureWorktreeOperationGenerationSnapshot } from './worktree-operation-generation'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import {
  findActiveRuntimeTerminal,
  type ActiveTerminalNoteTarget
} from './active-agent-note-target'
import { ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS } from './active-agent-terminal-send-readiness'

type ActiveAgentTerminalBinding = {
  authority: string
  terminal: RuntimeTerminalListResult['terminals'][number]
}

const activeAgentTerminalBindings = new Map<string, ActiveAgentTerminalBinding>()

function getRuntimeBindingAuthority(
  state: Parameters<typeof resolveWorktreeOperationRoute>[0],
  worktreeId: string,
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>
): string {
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  if (route) {
    return JSON.stringify(captureWorktreeOperationGenerationSnapshot(route))
  }
  // Why: only environment targets carry a connection generation; other targets rely on the terminal_handle_stale path to drop a rebound handle.
  const generation =
    runtimeTarget.kind === 'environment'
      ? getRuntimeEnvironmentConnectionGeneration(runtimeTarget.environmentId)
      : 0
  return JSON.stringify({ runtimeTarget, generation })
}

function getBindingKey(
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget,
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>
): string {
  return JSON.stringify({
    runtimeTarget,
    worktreeId,
    tabId: noteTarget.tabId,
    leafId: noteTarget.leafId
  })
}

export async function resolveActiveAgentTerminal(
  state: Parameters<typeof resolveWorktreeOperationRoute>[0],
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget
): Promise<RuntimeTerminalListResult['terminals'][number] | null> {
  const key = getBindingKey(worktreeId, noteTarget, runtimeTarget)
  const authority = getRuntimeBindingAuthority(state, worktreeId, runtimeTarget)
  const cached = activeAgentTerminalBindings.get(key)
  if (cached) {
    if (cached.authority === authority) {
      return cached.terminal
    }
    activeAgentTerminalBindings.delete(key)
  }

  const terminal = await findActiveRuntimeTerminal(
    runtimeTarget,
    worktreeId,
    noteTarget,
    ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS
  )
  if (terminal) {
    activeAgentTerminalBindings.set(key, { authority, terminal })
  }
  return terminal
}

export function clearActiveAgentTerminalBinding(
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget,
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>
): void {
  activeAgentTerminalBindings.delete(getBindingKey(worktreeId, noteTarget, runtimeTarget))
}

export function clearActiveAgentTerminalBindingCacheForTests(): void {
  activeAgentTerminalBindings.clear()
}
