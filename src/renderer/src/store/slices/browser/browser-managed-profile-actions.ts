import { createBrowserUuid } from '@/lib/browser-uuid'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import {
  isManagedBrowserProfileOf,
  managedBrowserProfileOwnerKey,
  unadmittedBrowserPartition,
  type ManagedBrowserProfileOwner
} from '../../../../../shared/browser-profile-scope'
import { withoutKey } from '../../../../../shared/workspace-layout/stored-record-fields'
import type { AppState } from '../../types'

// Use an inadmissible placeholder partition: failed/quit creations must never fall back to shared Default jar.
const placeholderProfile = (
  sessionProfileId: string
): { sessionProfileId: string; sessionPartition: string } => ({
  sessionProfileId,
  sessionPartition: unadmittedBrowserPartition(sessionProfileId)
})

const localProfiles = (state: AppState): BrowserSessionProfile[] =>
  state.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID] ?? []

// Managed profiles only ever live on this desktop, so they write the local list, never the focused host's.
const localProfilesUpdate = (
  state: AppState,
  profiles: BrowserSessionProfile[]
): Partial<BrowserSlice> => ({
  browserSessionProfilesByHostId: {
    ...state.browserSessionProfilesByHostId,
    [LOCAL_EXECUTION_HOST_ID]: profiles
  },
  // Why identity: Settings mirrors one host's list by reference; when that is the local one it follows.
  ...(state.browserSessionProfiles === state.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID]
    ? { browserSessionProfiles: profiles }
    : {})
})

export function createBrowserManagedProfileActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'ensureManagedBrowserSessionProfile' | 'deleteManagedBrowserSessionProfile'> {
  // Placeholder ids handed out while main creates an owner's profile, so a second tab joins the first.
  const placeholderIdByOwner = new Map<string, string>()
  const findLocalProfile = (owner: ManagedBrowserProfileOwner) =>
    localProfiles(get()).find((profile) => isManagedBrowserProfileOf(profile, owner))
  const setStatus = (profileId: string, status: 'pending' | 'failed' | null): void =>
    set((s) => ({
      managedBrowserProfileStatusById: status
        ? { ...s.managedBrowserProfileStatusById, [profileId]: status }
        : (withoutKey(s.managedBrowserProfileStatusById, profileId) ?? {})
    }))
  // Lists main's profile and moves every tab, open or closed, off the id it replaces.
  const adopt = (profile: BrowserSessionProfile, replacedId: string): void => {
    set((s) => ({
      ...localProfilesUpdate(s, [
        ...localProfiles(s).filter(
          (existing) => existing.id !== profile.id && existing.id !== replacedId
        ),
        profile
      ]),
      // Why: a tab closed while it waited would otherwise reopen on an id main never made.
      recentlyClosedBrowserTabsByWorktree: Object.fromEntries(
        Object.entries(s.recentlyClosedBrowserTabsByWorktree).map(([worktreeId, closed]) => [
          worktreeId,
          closed.map((entry) =>
            entry.workspace.sessionProfileId === replacedId
              ? {
                  ...entry,
                  workspace: {
                    ...entry.workspace,
                    sessionProfileId: profile.id,
                    sessionPartition: null
                  }
                }
              : entry
          )
        ])
      )
    }))
    for (const tab of Object.values(get().browserTabsByWorktree).flat()) {
      if (tab.sessionProfileId === replacedId) {
        get().switchBrowserTabProfile(tab.id, profile.id)
      }
    }
  }

  return {
    ensureManagedBrowserSessionProfile: (owner, label) => {
      const key = managedBrowserProfileOwnerKey(owner)
      const pendingId = placeholderIdByOwner.get(key)
      if (pendingId) {
        return placeholderProfile(pendingId)
      }
      const listedId = findLocalProfile(owner)?.id
      if (listedId) {
        // Why ask anyway: a removal elsewhere may have deleted it; main then makes a new one.
        window.api.browser.sessionEnsureManagedProfile({ owner, label }).then(
          (profile) => {
            if (profile && profile.id !== listedId) {
              adopt(profile, listedId)
            }
          },
          () => {}
        )
        return { sessionProfileId: listedId }
      }
      // Why a placeholder: main mints the id, and until it answers this tab's pages must not mount.
      const placeholderId = createBrowserUuid()
      placeholderIdByOwner.set(key, placeholderId)
      setStatus(placeholderId, 'pending')
      const settle = (profile: BrowserSessionProfile | null): void => {
        placeholderIdByOwner.delete(key)
        if (profile) {
          adopt(profile, placeholderId)
        }
        setStatus(placeholderId, profile ? null : 'failed')
      }
      window.api.browser
        .sessionEnsureManagedProfile({ owner, label })
        .then(settle, () => settle(null))
      return placeholderProfile(placeholderId)
    },

    deleteManagedBrowserSessionProfile: async (owner) => {
      const profile = findLocalProfile(owner)
      if (!profile) {
        return
      }
      try {
        await window.api.browser.sessionDeleteProfile({ profileId: profile.id })
      } catch {
        // Why: best-effort; a profile that outlives its workspace only costs disk until deleted in Settings.
      }
      // Why regardless of the answer: the owner's removal on its host may already have deleted it in main.
      set((s) =>
        localProfilesUpdate(
          s,
          localProfiles(s).filter((existing) => existing.id !== profile.id)
        )
      )
    }
  }
}
