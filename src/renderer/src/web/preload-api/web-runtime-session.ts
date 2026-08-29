import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { Worktree } from '../../../../shared/worktree/types'
import { WebRuntimeClient } from '../web-runtime-client'
import {
  clearStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  readStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId
} from '../web-runtime-environment'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'

export const webRuntimeState: {
  activeEnvironment: StoredWebRuntimeEnvironment | null
  worktreeVisibilityDefaultsRuntimeEnvironmentId: string | null
  worktreeVisibilityDefaultsRuntimeValue: WorktreeVisibilityDefaults | null
  activeClient: WebRuntimeClient | null
  activeClientEnvironmentId: string | null
  cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
  cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
} = {
  activeEnvironment: readStoredWebRuntimeEnvironment(),
  worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
  worktreeVisibilityDefaultsRuntimeValue: null,
  activeClient: null,
  activeClientEnvironmentId: null,
  cachedWorktrees: null,
  cachedDetectedWorktrees: null
}

export const manuallyDisconnectedEnvironmentIds = new Set<string>()

export const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function invalidateRuntimeWorktreeCaches(): void {
  webRuntimeState.cachedWorktrees = null
  webRuntimeState.cachedDetectedWorktrees = null
}

export function getClientForEnvironment(
  environment: StoredWebRuntimeEnvironment
): WebRuntimeClient {
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    throw new Error('runtime_manually_disconnected')
  }
  if (
    !webRuntimeState.activeClient ||
    webRuntimeState.activeClientEnvironmentId !== environment.id
  ) {
    webRuntimeState.activeClient?.close()
    webRuntimeState.activeClient = new WebRuntimeClient(getPreferredWebPairingOffer(environment))
    webRuntimeState.activeClientEnvironmentId = environment.id
  }
  return webRuntimeState.activeClient
}

export function closeActiveRuntimeClients(): void {
  webRuntimeState.activeClient?.close()
  webRuntimeState.activeClient = null
  webRuntimeState.activeClientEnvironmentId = null
  invalidateRuntimeWorktreeCaches()
}

export function disconnectActiveRuntimeEnvironment(): void {
  closeActiveRuntimeClients()
}

export function removeActiveRuntimeEnvironment(): void {
  disconnectActiveRuntimeEnvironment()
  clearStoredWebRuntimeEnvironment()
  webRuntimeState.activeEnvironment = null
}

export function manuallyDisconnectedResponse(
  environment: StoredWebRuntimeEnvironment
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: translate(
        'auto.web.webPreloadApi.runtimeEnvironmentManuallyDisconnected',
        'Runtime environment is manually disconnected.'
      )
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function resolveEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = requireActiveEnvironment()
  if (selector === environment.id || selector === environment.name || selector === 'active') {
    return environment
  }
  if (environment.compatibleEnvironmentIds?.includes(selector)) {
    return environment
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

export function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readStoredWebRuntimeEnvironment()
  if (!webRuntimeState.activeEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return webRuntimeState.activeEnvironment
}

export function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readStoredWebRuntimeEnvironment()
  return webRuntimeState.activeEnvironment
}

export function assertActiveEnvironment(environmentId: string): void {
  if (requireActiveEnvironment().id !== environmentId) {
    throw new Error('The paired Orca server changed while the request was in progress.')
  }
}

export function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  if (webRuntimeState.activeEnvironment?.id !== environment.id) {
    return
  }
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  const pairedDeviceId =
    response.ok &&
    typeof response.result === 'object' &&
    response.result !== null &&
    typeof (response.result as { pairedDeviceId?: unknown }).pairedDeviceId === 'string'
      ? (response.result as { pairedDeviceId: string }).pairedDeviceId
      : undefined
  webRuntimeState.activeEnvironment = updateStoredEnvironmentRuntimeId(
    environment,
    runtimeId,
    pairedDeviceId
  )
}
