import type { AgentContextInspectTarget, AgentContextReport } from '../../../shared/agent-context'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

const AGENT_CONTEXT_TIMEOUT_MS = 15_000

/**
 * Inspect agent context on the runtime that runs the agents — same host rule as
 * `discoverSkillsForRuntimeTarget`: a remote runtime receives workspace identity
 * only, never the client's WSL/project-runtime resolution.
 */
export async function inspectAgentContextForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  target?: AgentContextInspectTarget
): Promise<AgentContextReport> {
  if (runtimeTarget.kind === 'local') {
    return window.api.agentContext.inspect(target)
  }
  return callRuntimeRpc<AgentContextReport>(
    runtimeTarget,
    'agentContext.inspect',
    { cwd: target?.cwd, worktreeId: target?.worktreeId },
    { timeoutMs: AGENT_CONTEXT_TIMEOUT_MS }
  )
}
