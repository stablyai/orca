export const MOBILE_RELAY_PROVIDERS = ['official', 'self-hosted'] as const

export type MobileRelayProvider = (typeof MOBILE_RELAY_PROVIDERS)[number]

export type SelfHostedRelaySettings = {
  url: string
  accessKey: string
}

export type SelfHostedRelaySettingsResult = { ok: true } | { ok: false; message: string }

export function resolveMobileRelayProvider(value: unknown): MobileRelayProvider {
  if (value === undefined || value === null || value === 'official') {
    return 'official'
  }
  if (value === 'self-hosted') {
    return 'self-hosted'
  }
  throw new Error('relay_provider_unavailable')
}
