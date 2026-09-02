import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import {
  clearClientHostedBrowserCloseIntents,
  recordClientHostedBrowserCloseIntents
} from '@/runtime/client-hosted-browser-close-intents'
import { getBrowserSettingsHostId } from './browser-host-state'
import { parseExecutionHostId } from '../../../../../shared/execution-host'

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
        return next ? { clientHostedBrowserCloseIntentsByEnvironment: next } : {}
      })
    },

    clearClientHostedBrowserCloseIntents: (environmentId, browserPageIds) => {
      set((s) => {
        const next = clearClientHostedBrowserCloseIntents(
          s.clientHostedBrowserCloseIntentsByEnvironment,
          { environmentId, browserPageIds, now: Date.now() }
        )
        return next ? { clientHostedBrowserCloseIntentsByEnvironment: next } : {}
      })
    },

    setBrowserSessionHostId: async (hostId) => {
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind !== 'local' && parsed?.kind !== 'runtime') {
        return
      }
      const nextHostId = parsed.id
      set((s) => ({
        browserSessionHostIdOverride: nextHostId,
        browserSessionProfiles: s.browserSessionProfilesByHostId[nextHostId] ?? [],
        defaultBrowserSessionProfileId:
          s.defaultBrowserSessionProfileIdByHostId[nextHostId] ?? null,
        browserSessionImportState: null,
        detectedBrowsers: [],
        detectedBrowsersLoaded: false,
        detectedBrowsersHost: null
      }))
      await Promise.all([get().fetchBrowserSessionProfiles(), get().fetchDetectedBrowsers()])
    },

    setDefaultBrowserSessionProfileId: (profileId) => {
      set((s) => ({
        defaultBrowserSessionProfileId: profileId,
        defaultBrowserSessionProfileIdByHostId: {
          ...s.defaultBrowserSessionProfileIdByHostId,
          [getBrowserSettingsHostId(s)]: profileId
        }
      }))
    }
  }
}
