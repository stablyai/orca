import { detectWebDeviceKeySupport, type WebDeviceKeySupport } from './web-device-key'

let detected: WebDeviceKeySupport | null = null

/** Probes once at startup; the web entry awaits it before deciding where a pairing is stored. */
export async function initWebDeviceKeySupport(): Promise<WebDeviceKeySupport> {
  detected ??= await detectWebDeviceKeySupport({
    isSecureContext: window.isSecureContext,
    crypto: window.crypto,
    indexedDB: window.indexedDB
  })
  return detected
}

// null until probed: callers then keep today's behaviour (a stored token, legacy auth).
export function readWebDeviceKeySupport(): WebDeviceKeySupport | null {
  return detected
}

export function setWebDeviceKeySupportForTests(support: WebDeviceKeySupport | null): void {
  detected = support
}
