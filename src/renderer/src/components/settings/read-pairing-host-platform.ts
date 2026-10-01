// Why: the pairing helpers run in the sandboxed renderer, which has no `process`.
// The preload publishes the host platform. Guessing darwin or win32 would advertise
// a different address from the one main already put on the QR.
export function readPairingHostPlatform(): NodeJS.Platform {
  const platform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (!platform) {
    throw new Error('The host platform is not available to the pairing picker.')
  }
  return platform
}
