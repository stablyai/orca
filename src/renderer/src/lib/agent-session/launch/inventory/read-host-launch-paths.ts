import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { getLocalAgentPreflightContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { callRuntimeAgentDetection } from '@/store/slices/agent-inventory/runtime-agent-detection-request'
import type { AgentDetectionReply } from '@/store/slices/agent-inventory/managed-agent-launch-commands'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Read launch paths through the existing host preflight, without publishing inventory UI state. */
export async function readHostLaunchPaths(
  state: AppState,
  target: RuntimeClientTarget,
  worktreeId: string | null
): Promise<Record<string, string> | undefined> {
  if (worktreeId && getConnectionIdFromState(state, worktreeId)) {
    return {}
  }
  try {
    if (target.kind === 'local') {
      const context = getLocalAgentPreflightContext(state, undefined, undefined, worktreeId)
      const reply = await window.api.preflight.detectAgents({
        ...context,
        withManagedAgentCommands: true
      })
      return reply.managedAgentCommands ?? {}
    }
    const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
      target.environmentId
    )
    const reply = await callRuntimeAgentDetection(target.environmentId, worktreeId, (params) =>
      callRuntimeRpc<AgentDetectionReply>(
        target,
        'preflight.detectAgents',
        { ...params, withManagedAgentCommands: true },
        { expectedEnvironmentPairingRevision }
      )
    )
    return 'agents' in reply ? (reply.managedAgentCommands ?? {}) : undefined
  } catch {
    return undefined
  }
}
