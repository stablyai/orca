import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

export type StoredEndpointOverride = {
  endpoint: string
  // Why: only the exact stored endpoint this override was minted for may be
  // redirected — a re-pair or a user edit replaces it, and the override must die
  // rather than misdirect the environment.
  forEndpoint: string
}

const ENDPOINT_OVERRIDES_KEY = 'orca.web.runtimeEndpointOverrides.v1'

function readEndpointOverrides(): Record<string, StoredEndpointOverride> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ENDPOINT_OVERRIDES_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function getEndpointOverride(
  environment: StoredWebRuntimeEnvironment
): StoredEndpointOverride | null {
  const override = readEndpointOverrides()[environment.id]
  if (!override || typeof override.endpoint !== 'string') {
    return null
  }
  const preferred =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  return preferred?.endpoint === override.forEndpoint ? override : null
}

export function setEndpointOverride(environmentId: string, override: StoredEndpointOverride): void {
  const overrides = readEndpointOverrides()
  overrides[environmentId] = override
  window.localStorage.setItem(ENDPOINT_OVERRIDES_KEY, JSON.stringify(overrides))
}

export function clearEndpointOverride(environmentId: string): void {
  const overrides = readEndpointOverrides()
  if (!(environmentId in overrides)) {
    return
  }
  delete overrides[environmentId]
  window.localStorage.setItem(ENDPOINT_OVERRIDES_KEY, JSON.stringify(overrides))
}
