import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-launch-runtime-capability'
import { WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { ClientWorktreeCreateSettings } from './client-worktree-create-settings'
import {
  buildRuntimeWorktreeCreateParams,
  type CreatedWorktreeResult,
  type HostAgentLaunch,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'

/** Choose one planner for paired-host create: capable host settings or universally accepted desktop-built command. */
export async function createWorktreeOnRuntimeHost(
  environmentId: string,
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  clientCreateSettings: ClientWorktreeCreateSettings
): Promise<CreatedWorktreeResult> {
  const clientAutomationProvenance = request.options?.clientAutomationProvenance
  // Why: only a capable host accepts the field; older ones create the same plain workspace as before.
  const provenanceParams =
    clientAutomationProvenance &&
    (await hostSupportsCapability(
      environmentId,
      WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY
    ))
      ? { clientAutomationProvenance }
      : {}
  const call = (launch?: HostAgentLaunch): Promise<CreateWorktreeResult> =>
    callRuntimeRpc<CreateWorktreeResult>(
      { kind: 'environment', environmentId },
      'worktree.create',
      {
        ...buildRuntimeWorktreeCreateParams(request, attempt, launch),
        ...provenanceParams,
        // Why: the host's own store defaults would otherwise override the user's choices.
        ...clientCreateSettings
      },
      { timeoutMs: 10 * 60_000 }
    )
  const launch = request.options?.hostAgentLaunch
  if (!launch || !(await hostSupportsCapability(environmentId, AGENT_LAUNCH_RUNTIME_CAPABILITY))) {
    return call()
  }
  try {
    return { ...(await call(launch)), hostPlannedStartup: true }
  } catch (error) {
    if (!isUnknownAgentRefusal(error)) {
      throw error
    }
    // Why: a host older than the agent refuses its name while validating, before creating anything.
    return call()
  }
}

/** A failed read-only probe keeps the older plan; a compat block still stops the create. */
async function hostSupportsCapability(environmentId: string, capability: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(environmentId, capability)
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    return false
  }
}

function isUnknownAgentRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    error.code === 'invalid_argument' &&
    error.message === 'Unknown TUI agent'
  )
}
