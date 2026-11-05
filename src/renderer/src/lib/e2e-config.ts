import { createE2EConfig } from '../../../shared/e2e-config'

const rendererE2EExposeStore = String(import.meta.env.VITE_EXPOSE_STORE) === 'true'
// The paired API installs after module initialization; read the build-gated test URL before caching configuration.
const rendererE2EQuery =
  rendererE2EExposeStore && typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null
export const e2eDisableRemoteTerminalStallRecovery =
  rendererE2EExposeStore &&
  rendererE2EQuery?.get('orcaE2EDisableRemoteTerminalStallRecovery') === '1'
const rendererFallbackE2EConfig = createE2EConfig({
  exposeStore: rendererE2EExposeStore,
  terminalParkingDelayMs: Number(rendererE2EQuery?.get('orcaE2ETerminalParkingDelayMs')) || null,
  terminalRetentionLimit: Number(rendererE2EQuery?.get('orcaE2ETerminalRetentionLimit')) || null
})

// Consume preload’s bridged startup contract rather than renderer env variables.
export const e2eConfig =
  typeof window !== 'undefined' && window.api?.e2e
    ? window.api.e2e.getConfig()
    : rendererFallbackE2EConfig
