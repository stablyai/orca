import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  MCodeProfileAuthStatus,
  MCodeProfileSummary,
  SwitchMCodeProfileResult,
  TransferMCodeProfileProjectArgs,
  TransferMCodeProfileProjectResult
} from '../../../../shared/mcode-profiles'
import type { AppState } from '../types'
import {
  createMCodeProfilesAuthActions,
  type MCodeProfilesAuthActions
} from './mcode-profiles-auth-actions'

export type MCodeProfilesSlice = MCodeProfilesAuthActions & {
  mcodeProfiles: MCodeProfileSummary[]
  activeMCodeProfileId: string | null
  mcodeProfileAuthStatus: MCodeProfileAuthStatus | null
  mcodeProfilesMultiProfileUi: boolean
  mcodeProfilesLoading: boolean
  mcodeProfileSwitching: boolean
  mcodeProfileConnecting: boolean
  fetchMCodeProfiles: () => Promise<void>
  fetchMCodeProfileAuthStatus: () => Promise<MCodeProfileAuthStatus | null>
  createLocalMCodeProfile: (name?: string) => Promise<MCodeProfileSummary | null>
  switchMCodeProfile: (profileId: string) => Promise<SwitchMCodeProfileResult | null>
  transferMCodeProfileProject: (
    args: TransferMCodeProfileProjectArgs
  ) => Promise<TransferMCodeProfileProjectResult | null>
}

export const createMCodeProfilesSlice: StateCreator<AppState, [], [], MCodeProfilesSlice> = (
  set,
  get,
  api
) => ({
  mcodeProfiles: [],
  activeMCodeProfileId: null,
  mcodeProfileAuthStatus: null,
  mcodeProfilesMultiProfileUi: false,
  mcodeProfilesLoading: false,
  mcodeProfileSwitching: false,
  mcodeProfileConnecting: false,

  fetchMCodeProfiles: async () => {
    set({ mcodeProfilesLoading: true })
    try {
      const [state, authStatus] = await Promise.all([
        window.api.mcodeProfiles.list(),
        window.api.mcodeProfiles.authStatus()
      ])
      set({
        activeMCodeProfileId: state.activeProfileId,
        mcodeProfiles: state.profiles,
        mcodeProfilesMultiProfileUi: state.multiProfileUi,
        mcodeProfileAuthStatus: authStatus,
        mcodeProfilesLoading: false
      })
    } catch (err) {
      console.error('Failed to fetch MCode profiles:', err)
      set({ mcodeProfilesLoading: false })
    }
  },

  fetchMCodeProfileAuthStatus: async () => {
    try {
      const authStatus = await window.api.mcodeProfiles.authStatus()
      set({ mcodeProfileAuthStatus: authStatus })
      return authStatus
    } catch (err) {
      console.error('Failed to fetch MCode profile auth status:', err)
      return null
    }
  },

  createLocalMCodeProfile: async (name) => {
    try {
      const state = await window.api.mcodeProfiles.createLocal({ name })
      set({
        activeMCodeProfileId: state.activeProfileId,
        mcodeProfiles: state.profiles
      })
      void get().fetchMCodeProfileAuthStatus()
      return state.profile
    } catch (err) {
      console.error('Failed to create MCode profile:', err)
      toast.error(
        translate('auto.store.slices.mcode.profiles.612f7f6861', 'Failed to create profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  ...createMCodeProfilesAuthActions(set, get, api),

  switchMCodeProfile: async (profileId) => {
    if (!profileId || profileId === get().activeMCodeProfileId) {
      return { status: 'already-active' }
    }
    set({ mcodeProfileSwitching: true })
    try {
      const result = await window.api.mcodeProfiles.switchProfile({ profileId })
      if (result?.status !== 'relaunching') {
        // Why: only a relaunch may keep the switcher locked; a stale
        // "already-active" answer would otherwise disable it forever.
        set({ mcodeProfileSwitching: false })
      }
      return result
    } catch (err) {
      console.error('Failed to switch MCode profile:', err)
      set({ mcodeProfileSwitching: false })
      toast.error(
        translate('auto.store.slices.mcode.profiles.7d4bc516ee', 'Failed to switch profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  transferMCodeProfileProject: async (args) => {
    try {
      const result = await window.api.mcodeProfiles.transferProject(args)
      if (result.status === 'duplicate-target') {
        toast.error(
          translate(
            'auto.store.slices.mcode.profiles.f518e89aa5',
            'Project already exists in that profile'
          )
        )
      }
      if (result.status === 'transferred' && result.willRelaunch) {
        set({ mcodeProfileSwitching: true })
      }
      return result
    } catch (err) {
      console.error('Failed to transfer MCode profile project:', err)
      toast.error(
        translate('auto.store.slices.mcode.profiles.f03ae7f27b', 'Failed to transfer project'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
