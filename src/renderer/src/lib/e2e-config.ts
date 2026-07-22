import { createE2EConfig } from '../../../shared/e2e-config'

// Why: preload owns the Electron startup contract, so renderer code should
// consume the bridged E2E config from window.api instead of reading env vars.
export const e2eConfig =
  typeof window !== 'undefined' && window.api?.e2e
    ? window.api.e2e.getConfig()
    : createE2EConfig({
        // Why: paired browser E2E has no preload bridge, so its build flag is the only safe test-hook signal.
        exposeStore: String(import.meta.env.VITE_EXPOSE_STORE) === 'true'
      })
