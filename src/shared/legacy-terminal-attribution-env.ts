import { TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY } from './protocol-version'

export const LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY = 'ORCA_ENABLE_GIT_ATTRIBUTION'
export const LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY = 'ORCA_ATTRIBUTION_BYPASS'
export const TERMINAL_SPLIT_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE =
  'Terminal splitting requires an updated workspace host that can verify attribution removal for every pane owner. Update the host and try again.'
export const TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE =
  'Creating terminals requires an updated workspace host that can verify attribution removal. Update the host and try again.'
export const MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE =
  'Creating terminals from Orca Mobile requires a newer workspace host that can verify safe terminal environment forwarding. Update the host and try again.'
export const SESSION_TAB_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE =
  'Creating terminals requires a newer workspace host that can verify safe terminal environment forwarding. Update the host and try again.'
const MAX_TERMINAL_ENV_DELETION_KEYS = 32

type TerminalAttributionHostStatus = {
  appVersion?: string
  capabilities?: string[]
}

function readTerminalAttributionHostStatus(value: unknown): TerminalAttributionHostStatus {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const appVersion = Reflect.get(value, 'appVersion')
  const capabilities = Reflect.get(value, 'capabilities')
  return {
    ...(typeof appVersion === 'string' ? { appVersion } : {}),
    ...(Array.isArray(capabilities) && capabilities.every((entry) => typeof entry === 'string')
      ? { capabilities }
      : {})
  }
}

export function hostSupportsTerminalSplitAttributionDisable(value: unknown): boolean {
  const status = readTerminalAttributionHostStatus(value)
  // Why: only removal-capable hosts cover both runtime- and renderer-owned split targets.
  return status.capabilities?.includes(TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY) === true
}

export function hostSupportsTerminalCreateAttributionDisable(value: unknown): boolean {
  const status = readTerminalAttributionHostStatus(value)
  return status.capabilities?.includes(TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY) === true
}

export function hostSupportsSessionTabTerminalCreateAttributionDisable(value: unknown): boolean {
  const status = readTerminalAttributionHostStatus(value)
  return status.capabilities?.includes(TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY) === true
}

export function withLegacyTerminalAttributionDisabledEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  return { ...env, [LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY]: '1' }
}

export function addLegacyTerminalAttributionDisableRequest(
  envToDelete: readonly string[] | undefined
): string[] | undefined {
  const deduplicated = [...new Set(envToDelete ?? [])]
  const gateIndex = deduplicated.indexOf(LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY)
  if (gateIndex !== -1) {
    deduplicated.splice(gateIndex, 1)
  }
  if (deduplicated.length >= MAX_TERMINAL_ENV_DELETION_KEYS) {
    throw new Error('Terminal environment deletion limit leaves no room for attribution cleanup')
  }
  return [...deduplicated, LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY]
}
