import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  OrcaProfileAuthStatus,
  OrcaProfileSummary,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult
} from '../../../../shared/orca-profiles'
import type { AppState } from '../types'
import {
  createOrcaProfilesAuthActions,
  type OrcaProfilesAuthActions
} from './orca-profiles-auth-actions'

export type OrcaProfilesSlice = OrcaProfilesAuthActions & {
  orcaProfiles: OrcaProfileSummary[]
  activeOrcaProfileId: string | null
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  orcaProfilesMultiProfileUi: boolean
  orcaProfilesLoading: boolean
  orcaProfileSwitching: boolean
  orcaProfileConnecting: boolean
  fetchOrcaProfiles: () => Promise<void>
  fetchOrcaProfileAuthStatus: () => Promise<OrcaProfileAuthStatus | null>
  createLocalOrcaProfile: (name?: string) => Promise<OrcaProfileSummary | null>
  switchOrcaProfile: (profileId: string) => Promise<SwitchOrcaProfileResult | null>
  transferOrcaProfileProject: (
    args: TransferOrcaProfileProjectArgs
  ) => Promise<TransferOrcaProfileProjectResult | null>
}

export const createOrcaProfilesSlice: StateCreator<AppState, [], [], OrcaProfilesSlice> = (
  set,
  get,
  api
) => ({
  orcaProfiles: [],
  activeOrcaProfileId: null,
  orcaProfileAuthStatus: null,
  orcaProfilesMultiProfileUi: false,
  orcaProfilesLoading: false,
  orcaProfileSwitching: false,
  orcaProfileConnecting: false,

  fetchOrcaProfiles: async () => {
    set({ orcaProfilesLoading: true })
    try {
      const [state, authStatus] = await Promise.all([
        window.api.orcaProfiles.list(),
        window.api.orcaProfiles.authStatus()
      ])
      set({
        activeOrcaProfileId: state.activeProfileId,
        orcaProfiles: state.profiles,
        orcaProfilesMultiProfileUi: state.multiProfileUi,
        orcaProfileAuthStatus: authStatus,
        orcaProfilesLoading: false
      })
    } catch (err) {
      console.error('Failed to fetch Orca profiles:', err)
      set({ orcaProfilesLoading: false })
    }
  },

  fetchOrcaProfileAuthStatus: async () => {
    try {
      const authStatus = await window.api.orcaProfiles.authStatus()
      set({ orcaProfileAuthStatus: authStatus })
      return authStatus
    } catch (err) {
      console.error('Failed to fetch Orca profile auth status:', err)
      return null
    }
  },

  createLocalOrcaProfile: async (name) => {
    try {
      const state = await window.api.orcaProfiles.createLocal({ name })
      set({
        activeOrcaProfileId: state.activeProfileId,
        orcaProfiles: state.profiles
      })
      void get().fetchOrcaProfileAuthStatus()
      return state.profile
    } catch (err) {
      console.error('Failed to create Orca profile:', err)
      toast.error(
        translate('auto.store.slices.orca.profiles.612f7f6861', 'Failed to create profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  ...createOrcaProfilesAuthActions(set, get, api),

  switchOrcaProfile: async (profileId) => {
    if (!profileId || profileId === get().activeOrcaProfileId) {
      return { status: 'already-active' }
    }
    set({ orcaProfileSwitching: true })
    try {
      const result = await window.api.orcaProfiles.switchProfile({ profileId })
      if (result?.status !== 'relaunching') {
        // Why: only a relaunch may keep the switcher locked; a stale
        // "already-active" answer would otherwise disable it forever.
        set({ orcaProfileSwitching: false })
      }
      return result
    } catch (err) {
      console.error('Failed to switch Orca profile:', err)
      set({ orcaProfileSwitching: false })
      toast.error(
        translate('auto.store.slices.orca.profiles.7d4bc516ee', 'Failed to switch profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  transferOrcaProfileProject: async (args) => {
    try {
      const result = await window.api.orcaProfiles.transferProject(args)
      if (result.status === 'duplicate-target') {
        toast.error(
          translate(
            'auto.store.slices.orca.profiles.f518e89aa5',
            'Project already exists in that profile'
          )
        )
      }
      if (result.status === 'transferred' && result.willRelaunch) {
        set({ orcaProfileSwitching: true })
      }
      return result
    } catch (err) {
      console.error('Failed to transfer Orca profile project:', err)
      toast.error(
        translate('auto.store.slices.orca.profiles.f03ae7f27b', 'Failed to transfer project'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
