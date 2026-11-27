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
import { assertRuntimeEnvironmentCapability } from '../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'

// Old servers lack the Bitbucket RPC methods; a capability check turns that into one clear message.
async function assertRemoteBitbucketCredentials(target: RuntimeClientTarget): Promise<void> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      BITBUCKET_REMOTE_CREDENTIALS_RUNTIME_CAPABILITY,
      BITBUCKET_REMOTE_CREDENTIALS_UPDATE_REQUIRED_MESSAGE,
      15_000
    )
  }
}

export async function bitbucketConnectionStatus(
  settings: RowLessSource
): Promise<BitbucketConnectionStatus> {
  const target = rowLessSourceTarget(settings)
  if (target.kind === 'environment') {
    await assertRemoteBitbucketCredentials(target)
    return callRuntimeRpc<BitbucketConnectionStatus>(target, 'bitbucket.status', undefined, {
      timeoutMs: 15_000
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
    await assertRemoteBitbucketCredentials(target)
    return callRuntimeRpc<BitbucketConnectResult>(
      target,
      'bitbucket.connect',
      { ...args },
      {
        timeoutMs: 30_000
      }
    )
  }
  return window.api.bitbucket.connect(args)
}

export async function disconnectBitbucketCredentials(settings: RowLessSource): Promise<void> {
  const target = rowLessSourceTarget(settings)
  if (target.kind === 'environment') {
    await assertRemoteBitbucketCredentials(target)
    await callRuntimeRpc(target, 'bitbucket.disconnect', undefined, { timeoutMs: 15_000 })
    return
  }
  await window.api.bitbucket.disconnect()
}
