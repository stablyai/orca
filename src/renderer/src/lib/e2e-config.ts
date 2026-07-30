import { createE2EConfig } from '../../../shared/e2e-config'

const rendererE2EExposeStore = String(import.meta.env.VITE_EXPOSE_STORE) === 'true'
// Why: the paired web API installs after static modules initialize, so its
// build-gated fallback must read the test URL before caching this config.
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

// Why: preload owns the Electron startup contract, so renderer code should
// consume the bridged E2E config from window.api instead of reading env vars.
export const e2eConfig =
  typeof window !== 'undefined' && window.api?.e2e
    ? window.api.e2e.getConfig()
    : rendererFallbackE2EConfig
