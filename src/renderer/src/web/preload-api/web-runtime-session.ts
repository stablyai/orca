import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { Worktree } from '../../../../shared/worktree/types'
import { WebRuntimeClient } from '../web-runtime-client'
import {
  getPreferredWebPairingOffer,
  readStoredWebRuntimeEnvironments,
  saveStoredWebRuntimeEnvironments,
  updateStoredEnvironmentRuntimeId
} from '../web-runtime-environment'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'

export const webRuntimeState: {
  activeEnvironment: StoredWebRuntimeEnvironment | null
  environments: StoredWebRuntimeEnvironment[]
  environmentById: Map<string, StoredWebRuntimeEnvironment>
  worktreeVisibilityDefaultsRuntimeEnvironmentId: string | null
  worktreeVisibilityDefaultsRuntimeValue: WorktreeVisibilityDefaults | null
  activeClient: WebRuntimeClient | null
  activeClientEnvironmentId: string | null
  cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
  cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
} = loadInitialState()

function loadInitialState(): {
  activeEnvironment: StoredWebRuntimeEnvironment | null
  environments: StoredWebRuntimeEnvironment[]
  environmentById: Map<string, StoredWebRuntimeEnvironment>
  worktreeVisibilityDefaultsRuntimeEnvironmentId: string | null
  worktreeVisibilityDefaultsRuntimeValue: WorktreeVisibilityDefaults | null
  activeClient: WebRuntimeClient | null
  activeClientEnvironmentId: string | null
  cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
  cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
} {
  const stored = readStoredWebRuntimeEnvironments()
  return {
    activeEnvironment: stored.activeEnvironmentId
      ? (stored.environments.find((env) => env.id === stored.activeEnvironmentId) ?? null)
      : null,
    environments: stored.environments,
    environmentById: new Map(stored.environments.map((env) => [env.id, env])),
    worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
    worktreeVisibilityDefaultsRuntimeValue: null,
    activeClient: null,
    activeClientEnvironmentId: null,
    cachedWorktrees: null,
    cachedDetectedWorktrees: null
  }
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

export function listStoredRuntimeEnvironments(): StoredWebRuntimeEnvironment[] {
  return webRuntimeState.environments
}

export function getStoredRuntimeEnvironmentById(id: string): StoredWebRuntimeEnvironment | null {
  return webRuntimeState.environmentById.get(id) ?? null
}

export function upsertStoredRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): StoredWebRuntimeEnvironment {
  const existing = webRuntimeState.environmentById.get(environment.id)
  const environments = existing
    ? webRuntimeState.environments.map((env) => (env.id === environment.id ? environment : env))
    : [...webRuntimeState.environments, environment]
  const byId = new Map(environments.map((env) => [env.id, env]))
  const activeEnvironmentId = webRuntimeState.activeEnvironment?.id ?? null
  // Why: persist before mutating in-memory state so a storage failure leaves state untouched.
  saveStoredWebRuntimeEnvironments({ environments, activeEnvironmentId })
  webRuntimeState.environments = environments
  webRuntimeState.environmentById = byId
  if (activeEnvironmentId === environment.id) {
    webRuntimeState.activeEnvironment = environment
  }
  return environment
}

export function setActiveRuntimeEnvironment(id: string): StoredWebRuntimeEnvironment {
  const environment = webRuntimeState.environmentById.get(id)
  if (!environment) {
    throw new Error(`Unknown Orca runtime environment: ${id}`)
  }
  closeActiveRuntimeClients()
  manuallyDisconnectedEnvironmentIds.delete(id)
  webRuntimeState.activeEnvironment = environment
  persistRegistry(id)
  invalidateRuntimeWorktreeCaches()
  return environment
}

export function removeStoredRuntimeEnvironment(id: string): boolean {
  const existing = webRuntimeState.environmentById.get(id)
  if (!existing) {
    return false
  }
  webRuntimeState.environments = webRuntimeState.environments.filter((env) => env.id !== id)
  webRuntimeState.environmentById.delete(id)
  if (webRuntimeState.activeEnvironment?.id === id) {
    closeActiveRuntimeClients()
    webRuntimeState.activeEnvironment = webRuntimeState.environments[0] ?? null
  }
  persistRegistry(webRuntimeState.activeEnvironment?.id ?? null)
  return true
}

export function removeActiveRuntimeEnvironment(): void {
  const activeId = webRuntimeState.activeEnvironment?.id
  if (activeId) {
    removeStoredRuntimeEnvironment(activeId)
  }
}

function persistRegistry(activeEnvironmentId: string | null): void {
  saveStoredWebRuntimeEnvironments({
    environments: webRuntimeState.environments,
    activeEnvironmentId
  })
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
  const active = requireActiveEnvironment()
  if (selector === active.id || selector === active.name || selector === 'active') {
    return active
  }
  if (active.compatibleEnvironmentIds?.includes(selector)) {
    return active
  }
  const byId = webRuntimeState.environmentById.get(selector)
  if (byId) {
    return byId
  }
  const byName = webRuntimeState.environments.find((env) => env.name === selector)
  if (byName) {
    return byName
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

export function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  if (!webRuntimeState.activeEnvironment) {
    restoreActiveFromRegistry()
  }
  if (!webRuntimeState.activeEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return webRuntimeState.activeEnvironment
}

export function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  if (!webRuntimeState.activeEnvironment) {
    restoreActiveFromRegistry()
  }
  return webRuntimeState.activeEnvironment
}

function restoreActiveFromRegistry(): void {
  // Why: module-level state can predate an in-test registry write; skip if already connected.
  if (webRuntimeState.activeEnvironment) {
    return
  }
  const stored = readStoredWebRuntimeEnvironments()
  webRuntimeState.environments = stored.environments
  webRuntimeState.environmentById = new Map(stored.environments.map((env) => [env.id, env]))
  webRuntimeState.activeEnvironment = stored.activeEnvironmentId
    ? (stored.environments.find((env) => env.id === stored.activeEnvironmentId) ?? null)
    : null
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
  const updated = updateStoredEnvironmentRuntimeId(environment, runtimeId, pairedDeviceId)
  webRuntimeState.activeEnvironment = updated
  upsertStoredRuntimeEnvironment(updated)
}
