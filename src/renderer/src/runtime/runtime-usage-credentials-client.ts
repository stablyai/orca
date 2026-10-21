import type { MiniMaxCredentialsStatus } from '../../../shared/minimax-credentials-status'
import type { ZcodePlanCredentialsStatus } from '../../../shared/zcode-plan-sites'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { USAGE_CREDENTIALS_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

const HOST_CREDENTIAL_TIMEOUT_MS = 20_000

/** The selected host predates saving usage keys over RPC; nothing was stored anywhere. */
export class UsageCredentialsHostOutdatedError extends Error {
  constructor() {
    super('This host needs a newer Orca to save usage keys.')
    this.name = 'UsageCredentialsHostOutdatedError'
  }
}

async function callHost<TResult>(
  environmentId: string,
  method: string,
  params?: unknown
): Promise<TResult> {
  // Why never local on refusal: the key belongs to the host whose poller reads it.
  if (
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      USAGE_CREDENTIALS_RUNTIME_CAPABILITY
    ))
  ) {
    throw new UsageCredentialsHostOutdatedError()
  }
  try {
    return await callRuntimeRpc<TResult>({ kind: 'environment', environmentId }, method, params, {
      timeoutMs: HOST_CREDENTIAL_TIMEOUT_MS
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new UsageCredentialsHostOutdatedError()
    }
    throw error
  }
}

export type MiniMaxCredentialAction =
  | 'getStatus'
  | 'saveApiKey'
  | 'clearApiKey'
  | 'saveCookie'
  | 'clearCookie'

export function callMiniMaxCredentials(
  owner: RuntimeClientTarget,
  action: MiniMaxCredentialAction,
  value = ''
): Promise<MiniMaxCredentialsStatus> {
  if (owner.kind === 'local') {
    const api = window.api.minimaxCredentials
    switch (action) {
      case 'getStatus':
        return api.getStatus()
      case 'saveApiKey':
        return api.saveApiKey(value)
      case 'clearApiKey':
        return api.clearApiKey()
      case 'saveCookie':
        return api.saveCookie(value)
      case 'clearCookie':
        return api.clearCookie()
    }
  }
  const { environmentId } = owner
  switch (action) {
    case 'getStatus':
      return callHost(environmentId, 'accounts.minimaxCredentialsStatus')
    case 'saveApiKey':
      return callHost(environmentId, 'accounts.minimaxSaveApiKey', { apiKey: value })
    case 'clearApiKey':
      return callHost(environmentId, 'accounts.minimaxClearApiKey')
    case 'saveCookie':
      return callHost(environmentId, 'accounts.minimaxSaveSessionCookie', { cookie: value })
    case 'clearCookie':
      return callHost(environmentId, 'accounts.minimaxClearSessionCookie')
  }
}

export type ZcodePlanCredentialAction = 'getStatus' | 'saveApiKey' | 'clearApiKey'

export function callZcodePlanCredentials(
  owner: RuntimeClientTarget,
  action: ZcodePlanCredentialAction,
  value = ''
): Promise<ZcodePlanCredentialsStatus> {
  if (owner.kind === 'local') {
    const api = window.api.zcodePlanCredentials
    switch (action) {
      case 'getStatus':
        return api.getStatus()
      case 'saveApiKey':
        return api.saveApiKey(value)
      case 'clearApiKey':
        return api.clearApiKey()
    }
  }
  const { environmentId } = owner
  switch (action) {
    case 'getStatus':
      return callHost(environmentId, 'accounts.zcodePlanCredentialsStatus')
    case 'saveApiKey':
      return callHost(environmentId, 'accounts.zcodePlanSaveApiKey', { apiKey: value })
    case 'clearApiKey':
      return callHost(environmentId, 'accounts.zcodePlanClearApiKey')
  }
}
