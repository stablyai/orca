import { isWebClientLocation } from './web-client-location'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../shared/source-control-runtime-capabilities'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '@/web/web-runtime-request-registry'

// Capture before the probe and carry the same authority through the actual queued dispatch.
export async function callGitHubTargetOperation<TResult>(args: {
  target: RuntimeClientTarget
  ownerRepo?: GitHubOwnerRepo | null
  method: string
  params: Record<string, unknown>
  local: (exact: { ownerRepo?: GitHubOwnerRepo }) => Promise<TResult>
  read?: boolean
  timeoutMs?: number
}): Promise<TResult> {
  let target = args.target
  if (target.kind === 'local' && isWebClientLocation()) {
    const { requireActiveEnvironment } = await import('@/web/preload-api/web-runtime-session')
    target = { kind: 'environment', environmentId: requireActiveEnvironment().id }
  }
  if (target.kind === 'local') {
    return args.local(args.ownerRepo ? { ownerRepo: args.ownerRepo } : {})
  }
  const environmentId = target.environmentId
  const revision = captureRuntimeEnvironmentRequestRevision(environmentId)
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const assertCurrent = () => {
    if (
      getRuntimeEnvironmentRevision(environmentId) !== revision ||
      getRuntimeEnvironmentConnectionGeneration(environmentId) !== generation
    ) {
      throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
    }
  }
  const status = args.ownerRepo
    ? await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: revision,
        beforeSend: assertCurrent
      })
    : null
  assertCurrent()
  const supported =
    status?.capabilities?.includes(GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY) === true
  if (args.ownerRepo && !supported && !args.read) {
    throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
  }
  const result = await callRuntimeRpc<TResult>(
    target,
    args.method,
    {
      ...args.params,
      ...(supported && args.ownerRepo ? { ownerRepo: args.ownerRepo } : {})
    },
    {
      timeoutMs: args.timeoutMs ?? 30_000,
      expectedEnvironmentPairingRevision: revision,
      expectedEnvironmentRuntimeId: status?.runtimeId,
      beforeSend: assertCurrent
    }
  )
  if (args.read) {
    assertCurrent()
  }
  return result
}
