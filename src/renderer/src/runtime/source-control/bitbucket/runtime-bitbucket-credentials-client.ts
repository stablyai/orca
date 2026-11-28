import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../../../../shared/bitbucket/bitbucket-credentials'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { BITBUCKET_CREDENTIALS_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { translate } from '../../../i18n/i18n'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'

const CONNECT_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 15_000

/** The selected server predates Bitbucket credential RPCs; nothing was saved anywhere. */
export class BitbucketCredentialsHostOutdatedError extends Error {
  constructor() {
    super(
      translate(
        'auto.runtime.bitbucket.credentialsNeedNewerServer',
        'Update the remote Orca server to save Bitbucket credentials there.'
      )
    )
    this.name = 'BitbucketCredentialsHostOutdatedError'
  }
}

async function callHost<TResult>(
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<TResult> {
  // Why never local on refusal: the credential belongs to the server whose preflight reads it.
  if (
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      BITBUCKET_CREDENTIALS_RUNTIME_CAPABILITY
    ))
  ) {
    throw new BitbucketCredentialsHostOutdatedError()
  }
  try {
    return await callRuntimeRpc<TResult>({ kind: 'environment', environmentId }, method, params, {
      timeoutMs
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new BitbucketCredentialsHostOutdatedError()
    }
    throw error
  }
}

export function bitbucketCredentialStatus(
  target: RuntimeClientTarget
): Promise<BitbucketConnectionStatus> {
  return target.kind === 'environment'
    ? callHost(target.environmentId, 'bitbucket.status', undefined, STATUS_TIMEOUT_MS)
    : window.api.bitbucket.status()
}

export function bitbucketConnect(
  target: RuntimeClientTarget,
  args: BitbucketConnectArgs
): Promise<BitbucketConnectResult> {
  return target.kind === 'environment'
    ? callHost(target.environmentId, 'bitbucket.connect', args, CONNECT_TIMEOUT_MS)
    : window.api.bitbucket.connect(args)
}

export async function bitbucketDisconnect(target: RuntimeClientTarget): Promise<void> {
  if (target.kind === 'environment') {
    await callHost(target.environmentId, 'bitbucket.disconnect', undefined, STATUS_TIMEOUT_MS)
    return
  }
  await window.api.bitbucket.disconnect()
}
