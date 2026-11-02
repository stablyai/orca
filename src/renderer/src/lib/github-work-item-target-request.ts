import type { GhAccountBinding } from '../../../shared/github/account-binding'
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
import {
  GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY,
  GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY,
  GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY
} from '../../../shared/task-source-runtime-capabilities'

// Capture before the probe and carry the same authority through the actual queued dispatch.
export async function callGitHubTargetOperation<TResult>(args: {
  target: RuntimeClientTarget
  ownerRepo?: GitHubOwnerRepo | null
  expectedGhAccount?: GhAccountBinding | null
  method: string
  params: Record<string, unknown>
  local: (exact: {
    ownerRepo?: GitHubOwnerRepo
    canonical?: boolean
    expectedGhAccount?: GhAccountBinding | null
  }) => Promise<TResult>
  read?: boolean
  canonical?: boolean
  rpcOptions?: Parameters<typeof callRuntimeRpc>[3]
  timeoutMs?: number
}): Promise<TResult> {
  let target = args.target
  if (target.kind === 'local' && isWebClientLocation()) {
    const { requireActiveEnvironment } = await import('@/web/preload-api/web-runtime-session')
    target = { kind: 'environment', environmentId: requireActiveEnvironment().id }
  }
  if (target.kind === 'local') {
    return args.local({
      ...(args.ownerRepo ? { ownerRepo: args.ownerRepo } : {}),
      ...(args.canonical !== undefined ? { canonical: args.canonical } : {}),
      ...(args.expectedGhAccount !== undefined ? { expectedGhAccount: args.expectedGhAccount } : {})
    })
  }
  const environmentId = target.environmentId
  const revision = captureRuntimeEnvironmentRequestRevision(
    environmentId,
    args.rpcOptions?.expectedEnvironmentPairingRevision
  )
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const assertCurrent = () => {
    args.rpcOptions?.beforeSend?.()
    if (
      getRuntimeEnvironmentRevision(environmentId) !== revision ||
      getRuntimeEnvironmentConnectionGeneration(environmentId) !== generation
    ) {
      throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
    }
  }
  const status =
    args.ownerRepo || args.canonical === true
      ? await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
          ...args.rpcOptions,
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: revision,
          beforeSend: assertCurrent
        })
      : null
  assertCurrent()
  const supported =
    status?.capabilities?.includes(GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY) === true
  const details = args.method === 'github.workItemDetails'
  const explicitIntent =
    details &&
    status?.capabilities?.includes(GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY) === true
  const legacyCanonical =
    details && status?.capabilities?.includes(GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY) === true
  if (args.canonical === true && !explicitIntent && !(legacyCanonical && args.ownerRepo)) {
    throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
  }
  if (args.ownerRepo && !supported && !args.read) {
    throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
  }
  const result = await callRuntimeRpc<TResult>(
    target,
    args.method,
    {
      ...args.params,
      ...(args.ownerRepo &&
      (explicitIntent || (legacyCanonical ? args.canonical === true : supported))
        ? { ownerRepo: args.ownerRepo }
        : {}),
      ...(explicitIntent && args.canonical !== undefined ? { canonical: args.canonical } : {}),
      ...(args.expectedGhAccount !== undefined &&
      status?.capabilities?.includes(GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY)
        ? { expectedGhAccount: args.expectedGhAccount }
        : {})
    },
    {
      ...args.rpcOptions,
      ...(status === null && args.expectedGhAccount !== undefined
        ? {
            paramsForStatus: (observed: RuntimeStatus | null) => ({
              ...args.params,
              ...(observed?.capabilities?.includes(GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY)
                ? { expectedGhAccount: args.expectedGhAccount }
                : {})
            })
          }
        : {}),
      timeoutMs: args.timeoutMs ?? 30_000,
      expectedEnvironmentPairingRevision: revision,
      expectedEnvironmentRuntimeId:
        args.rpcOptions?.expectedEnvironmentRuntimeId ?? status?.runtimeId,
      beforeSend: assertCurrent
    }
  )
  if (args.read) {
    assertCurrent()
  }
  return result
}
