import { isRecord } from '../agent-status/child-work/agent-status-child-work-value-guards'
import { cleanCloudServiceOrigin, cleanCloudServiceUrl } from '../network/cloud-service-url'

export type CustomCloudServerSettings = {
  enabled: boolean
  authServerUrl: string
  clientId: string
  relayDirectorUrl: string
}

export const DEFAULT_CLOUD_SERVER: CustomCloudServerSettings = {
  enabled: false,
  authServerUrl: 'https://login.onorca.dev',
  clientId: 'orca-desktop',
  relayDirectorUrl: 'https://relay.onorca.dev'
}

export function validateCustomCloudServer(
  value: unknown,
  allowLoopbackHttp: boolean
): CustomCloudServerSettings | null {
  if (!isRecord(value)) {
    return null
  }
  const candidate = value
  if (typeof candidate.enabled !== 'boolean') {
    return null
  }
  const authServerUrl =
    typeof candidate.authServerUrl === 'string'
      ? cleanCloudServiceUrl(candidate.authServerUrl, allowLoopbackHttp)
      : null
  const relayDirectorUrl =
    typeof candidate.relayDirectorUrl === 'string'
      ? cleanCloudServiceOrigin(candidate.relayDirectorUrl, allowLoopbackHttp)
      : null
  const clientId = typeof candidate.clientId === 'string' ? candidate.clientId.trim() : ''
  if (!authServerUrl || !relayDirectorUrl || !clientId || clientId.length > 256) {
    return null
  }
  const auth = new URL(authServerUrl)
  const relay = new URL(relayDirectorUrl)
  if (
    auth.pathname !== '/' ||
    auth.username ||
    auth.password ||
    auth.search ||
    auth.hash ||
    relay.username ||
    relay.password
  ) {
    return null
  }
  return { enabled: candidate.enabled, authServerUrl, clientId, relayDirectorUrl }
}

export type CloudServerConnectionTest = {
  auth: boolean
  relay: boolean
}

export type CloudServerSettingsState = {
  settings: CustomCloudServerSettings
  allowLoopbackHttp: boolean
  environmentOverrides: boolean
}

export type CustomCloudServerGlobalSettings = {
  customCloudServer?: CustomCloudServerSettings
}
