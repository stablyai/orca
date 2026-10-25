import type { AgentLaunchCancelResult } from '../../../shared/agent-launch-cancellation'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'
import type { DesktopCreateLaunchRecord } from './structured-agent-session-launch-record'

/** Explicit surface close abandons presentation now, independently of host prevention bookkeeping. */
export function cancelDesktopCreateOnClose(record: DesktopCreateLaunchRecord): void {
  const target = runtimeRpcTargetForAuthorityKey(record.executionHostId)
  if (!target) {
    return
  }
  const revision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  const current = (): boolean =>
    target.kind === 'local' ||
    (revision !== undefined &&
      getRuntimeEnvironmentRevision(target.environmentId) === revision &&
      !isRuntimeEnvironmentContinuationPending(target.environmentId, revision))
  if (!current()) {
    return
  }
  void callRuntimeRpc<AgentLaunchCancelResult>(
    target,
    'agent.launchCancel',
    structuredClone(record.desktopCreate.params),
    {
      ...(target.kind === 'environment' ? { expectedEnvironmentPairingRevision: revision } : {}),
      beforeSend: () => {
        if (!current()) {
          throw new Error('agent_session_operation_unknown')
        }
      }
    }
  ).catch((error: unknown) =>
    console.warn('[structured-agent-launch] closed surface cancellation unconfirmed', error)
  )
}
