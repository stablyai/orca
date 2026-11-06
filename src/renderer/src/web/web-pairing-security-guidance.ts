import { translate } from '@/i18n/i18n'
import type { WebDeviceKeySupport } from './web-device-key'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import { MIGRATED_DEVICE_TOKEN_PREFIX } from './web-runtime-credential-source'

// Plain HTTP retains reusable pairing codes for LAN/Tailscale access; guidance applies only to tab-limited secure browsers.
function needsGuidance(support: WebDeviceKeySupport | null): support is 'session-no-ed25519' {
  return support === 'session-no-ed25519'
}

/** What to tell the user about how this browser holds its pairing; null when nothing is at risk. */
export function webPairingSecurityGuidance(
  support: WebDeviceKeySupport | null,
  environment: StoredWebRuntimeEnvironment | null
): string | null {
  if (!needsGuidance(support) || !environment) {
    return null
  }
  if (environment.sessionOnly) {
    return webSessionPairingGuidance(support)
  }
  const storesCode = environment.endpoints.some(
    (endpoint) => !endpoint.deviceToken.startsWith(MIGRATED_DEVICE_TOKEN_PREFIX)
  )
  return storesCode
    ? translate(
        'auto.web.pairingSecurity.storedCodeNoEd25519',
        'This browser keeps a reusable pairing code, because it cannot create secure sign-in keys (Ed25519). Use a current browser and pair again for a safer pairing.'
      )
    : null
}

/** Shown before and after pairing when this browser can only pair for the current tab. */
export function webSessionPairingGuidance(support: WebDeviceKeySupport | null): string | null {
  return needsGuidance(support)
    ? translate(
        'auto.web.pairingSecurity.sessionNoEd25519',
        'This pairing lasts only while this tab is open, because this browser cannot create secure sign-in keys (Ed25519). Use a current browser for a pairing it remembers.'
      )
    : null
}
