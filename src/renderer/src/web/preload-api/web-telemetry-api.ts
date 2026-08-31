import type { PreloadApi } from '../../../../preload/api-types'

export function createWebTelemetryApi(): Partial<PreloadApi> {
  return {
    telemetryTrack: () => Promise.resolve(),
    telemetrySetOptIn: () => Promise.resolve(),
    telemetryGetConsentState: () =>
      Promise.resolve({ optedIn: false, source: 'default', blockedByEnv: false } as never),
    telemetryAcknowledgeBanner: () => Promise.resolve()
  }
}
