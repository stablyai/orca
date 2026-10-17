import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { IncognitoLockState } from '../../../../shared/incognito-projects'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '../types'

export type IncognitoProjectsDialog =
  | { kind: 'unlock' }
  /** No unlock method yet: a passcode must exist before anything can be hidden behind it. */
  | { kind: 'setup'; pendingRepo: { id: string; hostId: ExecutionHostId } | null }

export type IncognitoProjectsSlice = {
  /** Mirrors main, which forgets it on restart and screen lock. */
  incognitoProjectsUnlocked: boolean
  incognitoProjectsDialog: IncognitoProjectsDialog | null
  setIncognitoProjectsUnlocked: (unlocked: boolean) => void
  closeIncognitoProjectsDialog: () => void
  /** Touch ID when available; otherwise opens the passcode dialog. */
  requestIncognitoProjectsUnlock: () => Promise<void>
  lockIncognitoProjects: () => Promise<void>
  setProjectIncognito: (repo: Repo, incognito: boolean) => Promise<void>
  /** Called once a passcode exists, to finish a "Make incognito" that needed one first. */
  completeIncognitoProjectsSetup: () => Promise<void>
}

async function readLockState(): Promise<IncognitoLockState | null> {
  try {
    return await window.api.incognitoProjects.getState()
  } catch {
    return null
  }
}

export const createIncognitoProjectsSlice: StateCreator<
  AppState,
  [],
  [],
  IncognitoProjectsSlice
> = (set, get) => {
  const writeIncognitoFlag = async (
    repo: Pick<Repo, 'id'>,
    hostId: ExecutionHostId,
    incognito: boolean
  ): Promise<void> => {
    const saved = await get().updateRepo(repo.id, { incognito }, { hostId })
    if (!saved || !incognito || get().incognitoProjectsUnlocked) {
      return
    }
    toast.success(
      translate('incognitoProjects.madeIncognitoToast', 'Project hidden in incognito'),
      {
        description: translate(
          'incognitoProjects.madeIncognitoToastDescription',
          'Show it again with "Show incognito projects" in the sidebar\'s Workspace options menu.'
        )
      }
    )
  }

  return {
    incognitoProjectsUnlocked: false,
    incognitoProjectsDialog: null,

    setIncognitoProjectsUnlocked: (unlocked) => set({ incognitoProjectsUnlocked: unlocked }),

    closeIncognitoProjectsDialog: () => set({ incognitoProjectsDialog: null }),

    requestIncognitoProjectsUnlock: async () => {
      const state = await readLockState()
      if (!state || state.unlocked) {
        return
      }
      if (state.touchIdAvailable) {
        const result = await window.api.incognitoProjects.unlockWithTouchId()
        if (result.ok) {
          return
        }
      }
      set({
        incognitoProjectsDialog: state.passcodeSet
          ? { kind: 'unlock' }
          : { kind: 'setup', pendingRepo: null }
      })
    },

    lockIncognitoProjects: async () => {
      await window.api.incognitoProjects.lock()
    },

    setProjectIncognito: async (repo, incognito) => {
      const hostId = getRepoExecutionHostId(repo)
      if (incognito) {
        const state = await readLockState()
        if (!state) {
          return
        }
        if (!state.touchIdAvailable && !state.passcodeSet) {
          set({ incognitoProjectsDialog: { kind: 'setup', pendingRepo: { id: repo.id, hostId } } })
          return
        }
      }
      await writeIncognitoFlag(repo, hostId, incognito)
    },

    completeIncognitoProjectsSetup: async () => {
      const dialog = get().incognitoProjectsDialog
      set({ incognitoProjectsDialog: null })
      if (dialog?.kind === 'setup' && dialog.pendingRepo) {
        // Why: setting a passcode unlocks; relock so the project hides now, as it does with Touch ID.
        await window.api.incognitoProjects.lock()
        set({ incognitoProjectsUnlocked: false })
        await writeIncognitoFlag(dialog.pendingRepo, dialog.pendingRepo.hostId, true)
      }
    }
  }
}
