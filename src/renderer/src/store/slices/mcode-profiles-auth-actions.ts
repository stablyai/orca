import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ConnectCurrentMCodeProfileResult,
  CreateCloudLinkedMCodeProfileResult,
  RefreshCurrentMCodeProfileAuthResult,
  SelectMCodeProfileOrgResult,
  SignOutCurrentMCodeProfileResult
} from '../../../../shared/mcode-profiles'
import type { AppState } from '../types'

export type MCodeProfilesAuthActions = {
  createCloudLinkedMCodeProfile: (args: {
    orgId?: string
    name?: string
  }) => Promise<CreateCloudLinkedMCodeProfileResult | null>
  connectCurrentMCodeProfile: () => Promise<ConnectCurrentMCodeProfileResult | null>
  refreshCurrentMCodeProfileAuth: () => Promise<RefreshCurrentMCodeProfileAuthResult | null>
  signOutCurrentMCodeProfile: () => Promise<SignOutCurrentMCodeProfileResult | null>
  selectMCodeProfileOrg: (orgId: string) => Promise<SelectMCodeProfileOrgResult | null>
}

// Why a separate module: the cloud-auth actions share the profiles slice's
// state keys but form their own cohesive surface (connect/refresh/sign-out/
// org selection), and the combined slice file exceeded the repo line budget.
export const createMCodeProfilesAuthActions: StateCreator<
  AppState,
  [],
  [],
  MCodeProfilesAuthActions
> = (set, get) => ({
  createCloudLinkedMCodeProfile: async (args) => {
    try {
      const result = await window.api.mcodeProfiles.createCloudLinked(args)
      set({
        mcodeProfileAuthStatus: result.auth,
        ...(result.status === 'created'
          ? {
              activeMCodeProfileId: result.activeProfileId,
              mcodeProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'created') {
        toast.success(
          translate('auto.store.slices.mcode.profiles.319d7cf39b', 'Cloud profile created')
        )
      } else if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.f0c9e11a6d', 'Failed to create cloud profile'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to create MCode cloud profile:', err)
      toast.error(
        translate('auto.store.slices.mcode.profiles.f0c9e11a6d', 'Failed to create cloud profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  connectCurrentMCodeProfile: async () => {
    if (get().mcodeProfileConnecting) {
      return null
    }
    set({ mcodeProfileConnecting: true })
    try {
      const result = await window.api.mcodeProfiles.connectCurrent()
      set({
        mcodeProfileConnecting: false,
        mcodeProfileAuthStatus: result.auth,
        ...(result.status === 'connected'
          ? {
              activeMCodeProfileId: result.activeProfileId,
              mcodeProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'unconfigured') {
        toast.error(
          translate(
            'auto.store.slices.mcode.profiles.8b8fa73174',
            'MCode Cloud sign-in is not configured'
          ),
          {
            description: result.auth.setupMessage
          }
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.33290e88ed', 'Failed to connect profile'),
          { description: result.error }
        )
      } else if (result.status === 'connected') {
        toast.success(translate('auto.store.slices.mcode.profiles.9fcb07a796', 'Profile connected'))
      }
      return result
    } catch (err) {
      console.error('Failed to connect MCode profile:', err)
      set({ mcodeProfileConnecting: false })
      toast.error(
        translate('auto.store.slices.mcode.profiles.33290e88ed', 'Failed to connect profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  refreshCurrentMCodeProfileAuth: async () => {
    try {
      const result = await window.api.mcodeProfiles.refreshAuth()
      set({
        mcodeProfileAuthStatus: result.auth,
        ...(result.status === 'refreshed'
          ? {
              activeMCodeProfileId: result.activeProfileId,
              mcodeProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.2f6c78a039', 'Failed to refresh profile auth'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to refresh MCode profile auth:', err)
      toast.error(
        translate('auto.store.slices.mcode.profiles.2f6c78a039', 'Failed to refresh profile auth'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  signOutCurrentMCodeProfile: async () => {
    try {
      const result = await window.api.mcodeProfiles.signOutCurrent()
      set({
        activeMCodeProfileId: result.activeProfileId,
        mcodeProfiles: result.profiles,
        mcodeProfileAuthStatus: result.auth
      })
      toast.success(
        translate('auto.store.slices.mcode.profiles.a37b5e6d37', 'Signed out of profile')
      )
      return result
    } catch (err) {
      console.error('Failed to sign out of MCode profile:', err)
      toast.error(translate('auto.store.slices.mcode.profiles.83600521e7', 'Failed to sign out'), {
        description: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  },

  selectMCodeProfileOrg: async (orgId) => {
    try {
      const result = await window.api.mcodeProfiles.selectOrg({ orgId })
      set({
        mcodeProfileAuthStatus: result.auth,
        ...(result.status === 'selected'
          ? {
              activeMCodeProfileId: result.activeProfileId,
              mcodeProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.mcode.profiles.76deec8f58', 'Failed to switch organization'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to switch MCode profile org:', err)
      toast.error(
        translate('auto.store.slices.mcode.profiles.76deec8f58', 'Failed to switch organization'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
