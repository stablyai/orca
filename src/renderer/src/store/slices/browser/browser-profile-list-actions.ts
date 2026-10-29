import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult
} from '../../../../../shared/runtime-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getBrowserProfilesForHost,
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId,
  profileListByHostUpdate,
  getDefaultBrowserProfileForHost,
  listedProfilesByHostUpdate
} from './browser-host-state'

export function createBrowserProfileListActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  'fetchBrowserSessionProfiles' | 'createBrowserSessionProfile' | 'deleteBrowserSessionProfile'
> {
  // Why: change events can overlap fetches; only the latest listing per host may land, or an older one restores a deleted profile.
  const latestListingByHost = new Map<ExecutionHostId, number>()
  let listingCount = 0
  return {
    fetchBrowserSessionProfiles: async (requestedHostId) => {
      const hostId = requestedHostId ?? getBrowserSettingsHostId(get())
      const listing = ++listingCount
      latestListingByHost.set(hostId, listing)
      const isLatest = (): boolean => latestListingByHost.get(hostId) === listing
      const parsedHostId = parseExecutionHostId(hostId)
      const runtimeEnvironmentId =
        parsedHostId?.kind === 'runtime' ? parsedHostId.environmentId : null
      if (runtimeEnvironmentId) {
        try {
          const pairingRevision = captureRuntimeEnvironmentRequestRevision(runtimeEnvironmentId)
          const result = await callRuntimeRpc<BrowserProfileListResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileList',
            undefined,
            { timeoutMs: 15_000, expectedEnvironmentPairingRevision: pairingRevision }
          )
          // Server never observes client imports; overlay desktop-tracked import badges onto each environment’s jar.
          const clientImportSources = await window.api.browser
            .sessionClientRouteImportSources?.({ environmentId: runtimeEnvironmentId })
            .catch(() => ({}))
          const profiles = result.profiles.map((profile) =>
            !profile.source && clientImportSources?.[profile.id]
              ? { ...profile, source: clientImportSources[profile.id] }
              : profile
          )
          if (isLatest()) {
            set((s) => listedProfilesByHostUpdate(s, profiles, hostId))
          }
          return {
            hostId,
            environmentId: runtimeEnvironmentId,
            pairingRevision,
            profiles,
            executorRuntimeId: result.executorRuntimeId
          }
        } catch {
          if (isLatest()) {
            set((s) => profileListByHostUpdate(s, [], hostId))
          }
        }
        return
      }
      try {
        const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
        if (isLatest()) {
          set((s) => listedProfilesByHostUpdate(s, profiles, hostId))
        }
      } catch {
        /* best-effort — stale profile list is preferable to a crash */
      }
      return undefined
    },

    createBrowserSessionProfile: async (scope, label) => {
      const hostId = getBrowserSettingsHostId(get())
      const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
      if (runtimeEnvironmentId) {
        try {
          const result = await callRuntimeRpc<BrowserProfileCreateResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'browser.profileCreate',
            { scope, label },
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
        const profile = await window.api.browser.sessionCreateProfile({
          scope,
          label
        })
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
