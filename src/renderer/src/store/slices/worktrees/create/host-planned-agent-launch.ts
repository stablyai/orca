import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-launch-runtime-capability'
import { WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { PERFORCE_COPY_REQUEST_TIMEOUT_MS } from '../../../../../../shared/perforce/workspace-copy/workspace-copy-operations'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { assertPerforceRuntime, remotePerforceSettings } from '@/runtime/runtime-perforce-client'
import { pickClientWorktreeCreateSettings } from './client-worktree-create-settings'
import {
  buildRuntimeWorktreeCreateParams,
  type CreatedWorktreeResult,
  type HostAgentLaunch,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'

/** The client's settings; a paired host applies the ones a create needs instead of its own. */
export type HostCreateSettings = GlobalSettings | null | undefined

/** Choose one planner for paired-host create: capable host settings or universally accepted desktop-built command. */
export async function createWorktreeOnRuntimeHost(
  environmentId: string,
  hostRequest: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  settings: HostCreateSettings
): Promise<CreatedWorktreeResult> {
  let request = hostRequest
  if (request.options?.perforceCopy) {
    // Why: a host without Perforce copies would ignore the request and share the project folder.
    await assertPerforceRuntime({ kind: 'environment', environmentId })
    request = { ...request, perforceSettings: remotePerforceSettings(settings) }
  }
  const clientCreateSettings = pickClientWorktreeCreateSettings(settings)
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
      {
        timeoutMs: request.options?.perforceCopy ? PERFORCE_COPY_REQUEST_TIMEOUT_MS : 10 * 60_000
      }
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
