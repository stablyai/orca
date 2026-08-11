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

const ACTIVE_AGENT_TERMINAL_BINDING_CACHE_MAX = 128
const activeAgentTerminalBindings = new Map<string, ActiveAgentTerminalBinding>()

function rememberActiveAgentTerminalBinding(
  key: string,
  binding: ActiveAgentTerminalBinding
): void {
  activeAgentTerminalBindings.set(key, binding)
  while (activeAgentTerminalBindings.size > ACTIVE_AGENT_TERMINAL_BINDING_CACHE_MAX) {
    const oldestKey = activeAgentTerminalBindings.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    activeAgentTerminalBindings.delete(oldestKey)
  }
}

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
    rememberActiveAgentTerminalBinding(key, { authority, terminal })
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

export function getActiveAgentTerminalBindingCacheSizeForTests(): number {
  return activeAgentTerminalBindings.size
}
