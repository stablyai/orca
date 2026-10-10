import type { PreloadApi } from '../../../../preload/api-types'
import { getBrowserPlatform, noopUnsubscribe } from './web-storage'

export function createWebWorkspacePortsApi(): Partial<PreloadApi> {
  return {
    workspacePorts: {
      // Why: browser-local workspaces have no host process to inspect; return capability state instead of the generic undefined fallback.
      scan: () =>
        Promise.resolve({
          platform: getBrowserPlatform(),
          scannedAt: Date.now(),
          ports: [],
          unavailableReason: 'Workspace port scanning is unavailable for browser-local workspaces.'
        }),
      kill: () =>
        Promise.resolve({
          ok: false,
          reason: 'Workspace port management is unavailable for browser-local workspaces.'
        }),
      onAdvertisedUrlChanged: () => noopUnsubscribe
    }
  }
}
