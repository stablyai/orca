import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileResult,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult
} from '../../../../shared/orca-profiles'
import type { AppState } from '../types'

export type OrcaProfilesAuthActions = {
  createCloudLinkedOrcaProfile: (args: {
    orgId?: string
    name?: string
  }) => Promise<CreateCloudLinkedOrcaProfileResult | null>
  connectCurrentOrcaProfile: () => Promise<ConnectCurrentOrcaProfileResult | null>
  refreshCurrentOrcaProfileAuth: () => Promise<RefreshCurrentOrcaProfileAuthResult | null>
  signOutCurrentOrcaProfile: () => Promise<SignOutCurrentOrcaProfileResult | null>
  selectOrcaProfileOrg: (orgId: string) => Promise<SelectOrcaProfileOrgResult | null>
}

// Why a separate module: the cloud-auth actions share the profiles slice's
// state keys but form their own cohesive surface (connect/refresh/sign-out/
// org selection), and the combined slice file exceeded the repo line budget.
export const createOrcaProfilesAuthActions: StateCreator<
  AppState,
  [],
  [],
  OrcaProfilesAuthActions
> = (set, get) => {
  let nextConnectAttempt = 0
  let appliedConnectAttempt = 0

  return {
    createCloudLinkedOrcaProfile: async (args) => {
      try {
        const result = await window.api.orcaProfiles.createCloudLinked(args)
        set({
          orcaProfileAuthStatus: result.auth,
          ...(result.status === 'created'
            ? {
                activeOrcaProfileId: result.activeProfileId,
                orcaProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'created') {
          toast.success(
            translate('auto.store.slices.orca.profiles.319d7cf39b', 'Cloud profile created')
          )
        } else if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.orca.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.orca.profiles.f0c9e11a6d',
              'Failed to create cloud profile'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to create Orca cloud profile:', err)
        toast.error(
          translate('auto.store.slices.orca.profiles.f0c9e11a6d', 'Failed to create cloud profile'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    },

    connectCurrentOrcaProfile: async () => {
      const attempt = ++nextConnectAttempt
      try {
        // Why: a pending browser callback must not block retry. Another click
        // starts a second PKCE wait; an older wait is ignored after a newer
        // one has already linked.
        const result = await window.api.orcaProfiles.connectCurrent()
        if (attempt < appliedConnectAttempt) {
          return result
        }
        const alreadyConnected = get().orcaProfileAuthStatus?.state === 'connected'
        set({
          orcaProfileAuthStatus: result.auth,
          ...(result.status === 'connected'
            ? {
                activeOrcaProfileId: result.activeProfileId,
                orcaProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'connected') {
          appliedConnectAttempt = attempt
          if (!alreadyConnected) {
            toast.success(
              translate('auto.store.slices.orca.profiles.9fcb07a796', 'Profile connected')
            )
          }
        } else if (result.status === 'unconfigured') {
          toast.error(
            translate(
              'auto.store.slices.orca.profiles.8b8fa73174',
              'Orca Cloud sign-in is not configured'
            ),
            {
              description: result.auth.setupMessage
            }
          )
        } else if (
          result.status === 'failed' &&
          !alreadyConnected &&
          result.auth.state !== 'connected'
        ) {
          toast.error(
            translate('auto.store.slices.orca.profiles.33290e88ed', 'Failed to connect profile'),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to connect Orca profile:', err)
        if (
          attempt >= appliedConnectAttempt &&
          get().orcaProfileAuthStatus?.state !== 'connected'
        ) {
          toast.error(
            translate('auto.store.slices.orca.profiles.33290e88ed', 'Failed to connect profile'),
            {
              description: err instanceof Error ? err.message : String(err)
            }
          )
        }
        return null
      }
    },

    refreshCurrentOrcaProfileAuth: async () => {
      try {
        const result = await window.api.orcaProfiles.refreshAuth()
        set({
          orcaProfileAuthStatus: result.auth,
          ...(result.status === 'refreshed'
            ? {
                activeOrcaProfileId: result.activeProfileId,
                orcaProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.orca.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.orca.profiles.2f6c78a039',
              'Failed to refresh profile auth'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to refresh Orca profile auth:', err)
        toast.error(
          translate('auto.store.slices.orca.profiles.2f6c78a039', 'Failed to refresh profile auth'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    },

    signOutCurrentOrcaProfile: async () => {
      nextConnectAttempt += 1
      appliedConnectAttempt = nextConnectAttempt
      try {
        const result = await window.api.orcaProfiles.signOutCurrent()
        set({
          activeOrcaProfileId: result.activeProfileId,
          orcaProfiles: result.profiles,
          orcaProfileAuthStatus: result.auth
        })
        if (result.auth.state !== 'connected') {
          toast.success(
            translate('auto.store.slices.orca.profiles.a37b5e6d37', 'Signed out of profile')
          )
        }
        return result
      } catch (err) {
        console.error('Failed to sign out of Orca profile:', err)
        toast.error(translate('auto.store.slices.orca.profiles.83600521e7', 'Failed to sign out'), {
          description: err instanceof Error ? err.message : String(err)
        })
        return null
      }
    },

    selectOrcaProfileOrg: async (orgId) => {
      try {
        const result = await window.api.orcaProfiles.selectOrg({ orgId })
        set({
          orcaProfileAuthStatus: result.auth,
          ...(result.status === 'selected'
            ? {
                activeOrcaProfileId: result.activeProfileId,
                orcaProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.orca.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.orca.profiles.76deec8f58',
              'Failed to switch organization'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to switch Orca profile org:', err)
        toast.error(
          translate('auto.store.slices.orca.profiles.76deec8f58', 'Failed to switch organization'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    }
  }
}
