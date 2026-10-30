import { createE2EConfig } from '../../../../shared/e2e-config'

// Why: this module stays dependency-light so the query/storage snapshot evaluates before runtime state.
const webE2EExposeStore = String(import.meta.env.VITE_EXPOSE_STORE) === 'true'
const webE2EQuery = webE2EExposeStore ? new URLSearchParams(window.location.search) : null

export const webE2EConfig = createE2EConfig({
  exposeStore: webE2EExposeStore,
  terminalParkingDelayMs: Number(webE2EQuery?.get('orcaE2ETerminalParkingDelayMs')) || null,
  terminalRetentionLimit: Number(webE2EQuery?.get('orcaE2ETerminalRetentionLimit')) || null
})
