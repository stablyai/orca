import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import {
  clearClientHostedBrowserCloseIntents,
  recordClientHostedBrowserCloseIntents
} from '@/runtime/browser/closing/client-hosted-browser-close-intents'
import {
  getBrowserProfileHostId,
  getBrowserSettingsHostId,
  updateDefaultBrowserProfileForHost
} from './browser-host-state'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

export function createBrowserHostActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'recordClientHostedBrowserCloseIntents'
  | 'clearClientHostedBrowserCloseIntents'
  | 'setBrowserSessionHostId'
  | 'setDefaultBrowserSessionProfileId'
> {
  return {
    recordClientHostedBrowserCloseIntents: (closes) => {
      set((s) => {
        const next = recordClientHostedBrowserCloseIntents(
          s.clientHostedBrowserCloseIntentsByEnvironment,
          closes,
          Date.now()
        )
        return next ? { clientHostedBrowserCloseIntentsByEnvironment: next } : s
      })
    },

    clearClientHostedBrowserCloseIntents: (environmentId, browserPageIds) => {
      set((s) => {
        const next = clearClientHostedBrowserCloseIntents(
          s.clientHostedBrowserCloseIntentsByEnvironment,
          { environmentId, browserPageIds, now: Date.now() }
        )
        return next ? { clientHostedBrowserCloseIntentsByEnvironment: next } : s
      })
    },

    setBrowserSessionHostId: async (hostId) => {
      const parsed = parseExecutionHostId(hostId)
      if (!parsed) {
        return
      }
      const nextHostId = parsed.id
      set((s) => ({
        browserSessionHostIdOverride: nextHostId,
        browserSessionProfiles: s.browserSessionProfilesByHostId[nextHostId] ?? [],
        browserSessionImportState: null,
        detectedBrowsers: [],
        detectedBrowsersLoaded: false,
        detectedBrowsersHost: null
      }))
      await Promise.all([get().fetchBrowserSessionProfiles(), get().fetchDetectedBrowsers()])
    },

    // An SSH host's pages use this computer's default pick, so picking one there sets that.
    setDefaultBrowserSessionProfileId: (profileId) =>
      updateDefaultBrowserProfileForHost(
        get,
        getBrowserProfileHostId(getBrowserSettingsHostId(get())),
        () => profileId
      )
  }
}
