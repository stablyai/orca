import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../../../shared/bitbucket/bitbucket-credentials'
import {
  BITBUCKET_REMOTE_CREDENTIALS_RUNTIME_CAPABILITY,
  BITBUCKET_REMOTE_CREDENTIALS_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { rowLessSourceTarget } from '../hosts/selection/default-creation-host'
import type { RowLessSource } from '../hosts/selection/default-creation-host'
import { runtimeEnvironmentCapabilityProof } from '../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

/**
 * Old servers lack the Bitbucket RPC methods, so the capability answer doubles as admission: one
 * clear update-required message instead of unknown-method. The proof pins the runtime and pairing,
 * so a remove-and-re-pair during the wait cannot receive the credential payload.
 */
async function resolveRemoteBitbucketCredentials(
  target: EnvironmentTarget
): Promise<{ pairingRevision: number | undefined; runtimeId: string }> {
  const proof = await runtimeEnvironmentCapabilityProof(
    target.environmentId,
    BITBUCKET_REMOTE_CREDENTIALS_RUNTIME_CAPABILITY,
    15_000
  )
  if (!proof.supported) {
    throw new Error(BITBUCKET_REMOTE_CREDENTIALS_UPDATE_REQUIRED_MESSAGE)
  }
  return { pairingRevision: proof.pairingRevision, runtimeId: proof.runtimeId }
}

export async function bitbucketConnectionStatus(
  settings: RowLessSource
): Promise<BitbucketConnectionStatus> {
  const target = rowLessSourceTarget(settings)
  if (target.kind === 'environment') {
    const pin = await resolveRemoteBitbucketCredentials(target)
    return callRuntimeRpc<BitbucketConnectionStatus>(target, 'bitbucket.status', undefined, {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: pin.pairingRevision,
      expectedEnvironmentRuntimeId: pin.runtimeId
    })
  }
  return window.api.bitbucket.status()
}

export async function connectBitbucketCredentials(
  settings: RowLessSource,
  args: BitbucketConnectArgs
): Promise<BitbucketConnectResult> {
  const target = rowLessSourceTarget(settings)
  if (target.kind === 'environment') {
    const pin = await resolveRemoteBitbucketCredentials(target)
    return callRuntimeRpc<BitbucketConnectResult>(
      target,
      'bitbucket.connect',
      { ...args },
      {
        timeoutMs: 30_000,
        expectedEnvironmentPairingRevision: pin.pairingRevision,
        expectedEnvironmentRuntimeId: pin.runtimeId
      }
    )
  }
  return window.api.bitbucket.connect(args)
}

export async function disconnectBitbucketCredentials(settings: RowLessSource): Promise<void> {
  const target = rowLessSourceTarget(settings)
  if (target.kind === 'environment') {
    const pin = await resolveRemoteBitbucketCredentials(target)
    await callRuntimeRpc(target, 'bitbucket.disconnect', undefined, {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: pin.pairingRevision,
      expectedEnvironmentRuntimeId: pin.runtimeId
    })
    return
  }
  await window.api.bitbucket.disconnect()
}
