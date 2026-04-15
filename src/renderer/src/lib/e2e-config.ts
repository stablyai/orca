import { createE2EConfig } from '../../../shared/e2e-config'

// Why: preload owns the Electron startup contract, so renderer code should
// consume the bridged E2E config from window.api instead of reading env vars.
export const e2eConfig =
  typeof window !== 'undefined' && window.api?.e2e
    ? window.api.e2e.getConfig()
    : createE2EConfig({})
