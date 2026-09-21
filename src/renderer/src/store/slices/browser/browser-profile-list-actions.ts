import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult
} from '../../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getBrowserProfilesForHost,
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  profileListByHostUpdate,
  getDefaultBrowserProfileForHost
} from './browser-host-state'

export function createBrowserProfileListActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  'fetchBrowserSessionProfiles' | 'createBrowserSessionProfile' | 'deleteBrowserSessionProfile'
> {
  return {
    fetchBrowserSessionProfiles: async () => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileListResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileList',
            undefined,
            { timeoutMs: 15_000 }
          )
          // Why: client-hosted imports never touch the server, so the server's
          // records can't carry the "imported from Chrome" badge — this desktop
          // remembers what it imported into each environment's jar and overlays it.
          const clientImportSources = await window.api.browser
            .sessionClientRouteImportSources?.({ environmentId: runtimeEnvironmentId })
            .catch(() => ({}))
          const profiles = result.profiles.map((profile) =>
            !profile.source && clientImportSources?.[profile.id]
              ? { ...profile, source: clientImportSources[profile.id] }
              : profile
          )
          set((s) => profileListByHostUpdate(s, profiles, hostId))
        } catch {
          set((s) => profileListByHostUpdate(s, [], hostId))
        }
        return
      }
      try {
        const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
        set((s) => profileListByHostUpdate(s, profiles, hostId))
      } catch {
        /* best-effort — stale profile list is preferable to a crash */
      }
    },

    createBrowserSessionProfile: async (scope, label, options) => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileCreateResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileCreate',
            { scope, label, ...options },
            { timeoutMs: 15_000 }
          )
          const profile = result.profile
          if (profile) {
            set((s) => ({
              ...profileListByHostUpdate(
                s,
                [...getBrowserProfilesForHost(s, hostId), profile],
                hostId
              )
            }))
          }
          return profile
        } catch {
          return null
        }
      }
      try {
        const profile = (await window.api.browser.sessionCreateProfile({
          scope,
          label,
          ...options
        })) as BrowserSessionProfile | null
        if (profile) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              [...getBrowserProfilesForHost(s, hostId), profile],
              hostId
            )
          }))
        }
        return profile
      } catch {
        return null
      }
    },

    deleteBrowserSessionProfile: async (profileId) => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileDeleteResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileDelete',
            { profileId },
            { timeoutMs: 15_000 }
          )
          if (result.deleted) {
            set((s) => ({
              ...profileListByHostUpdate(
                s,
                getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
                hostId
              ),
              ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
                ? {
                    ...(getBrowserSettingsHostId(s) === hostId
                      ? { defaultBrowserSessionProfileId: null }
                      : {}),
                    defaultBrowserSessionProfileIdByHostId: {
                      ...s.defaultBrowserSessionProfileIdByHostId,
                      [hostId]: null
                    }
                  }
                : {})
            }))
          }
          return result.deleted
        } catch {
          return false
        }
      }
      try {
        const ok = await window.api.browser.sessionDeleteProfile({ profileId })
        if (ok) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
              hostId
            ),
            ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
              ? {
                  ...(getBrowserSettingsHostId(s) === hostId
                    ? { defaultBrowserSessionProfileId: null }
                    : {}),
                  defaultBrowserSessionProfileIdByHostId: {
                    ...s.defaultBrowserSessionProfileIdByHostId,
                    [hostId]: null
                  }
                }
              : {})
          }))
        }
        return ok
      } catch {
        return false
      }
    }
  }
}
