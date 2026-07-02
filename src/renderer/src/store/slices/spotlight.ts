import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  SpotlightChangedEvent,
  SpotlightError,
  SpotlightOpResult,
  SpotlightRepoState
} from '../../../../shared/spotlight'
import { translate } from '@/i18n/i18n'

const ERROR_TOAST_DURATION = 60_000

function spotlightErrorDescription(error: SpotlightError): string {
  switch (error.code) {
    case 'operation-in-progress':
      return translate(
        'auto.store.slices.spotlight.operationInProgress',
        'Finish or abort the merge/rebase in progress first.'
      )
    case 'root-diverged':
      return translate(
        'auto.store.slices.spotlight.rootDiverged',
        'The project root has changes made outside the Spotlight workspace. Commit or discard them there first.'
      )
    case 'restore-conflict':
      return translate(
        'auto.store.slices.spotlight.restoreConflict',
        'Restoring the original root changes conflicted. Resolve it in the project root, then retry.'
      )
    case 'unsupported-host':
      return translate(
        'auto.store.slices.spotlight.unsupportedHost',
        'Spotlight testing is not available for this project host yet.'
      )
    case 'bare-root':
    case 'branch-missing':
    case 'git-failed':
    case 'not-active':
    case 'repo-not-found':
    case 'root-is-holder':
    case 'unborn-head':
    case 'worktree-not-found':
      return error.message
  }
}

function reportSpotlightError(title: string, error: SpotlightError): void {
  toast.error(title, {
    description: spotlightErrorDescription(error),
    duration: ERROR_TOAST_DURATION
  })
}

export type SpotlightSlice = {
  /** Per-repo Spotlight state mirrored from main (the source of truth). */
  spotlightByRepo: Record<string, SpotlightRepoState>
  hydrateSpotlightState: () => Promise<void>
  applySpotlightChanged: (event: SpotlightChangedEvent) => void
  activateSpotlight: (repoId: string, worktreeId: string) => Promise<SpotlightOpResult>
  /** `silent` suppresses repeat error toasts — used by the auto-sync watcher
   *  so a persistent failure doesn't toast on every file change. */
  syncSpotlight: (repoId: string, opts?: { silent?: boolean }) => Promise<SpotlightOpResult>
  deactivateSpotlight: (repoId: string) => Promise<SpotlightOpResult>
}

export const createSpotlightSlice: StateCreator<AppState, [], [], SpotlightSlice> = (set, get) => {
  const applyState = (repoId: string, state: SpotlightRepoState | null): void => {
    set((s) => {
      if (!state) {
        if (!(repoId in s.spotlightByRepo)) {
          return {}
        }
        const next = { ...s.spotlightByRepo }
        delete next[repoId]
        return { spotlightByRepo: next }
      }
      return { spotlightByRepo: { ...s.spotlightByRepo, [repoId]: state } }
    })
  }

  return {
    spotlightByRepo: {},

    hydrateSpotlightState: async () => {
      try {
        const snapshot = await window.api.spotlight.getState()
        set({ spotlightByRepo: snapshot.byRepo })
      } catch (err) {
        console.error('Failed to hydrate spotlight state:', err)
      }
    },

    applySpotlightChanged: (event) => {
      applyState(event.repoId, event.state)
    },

    activateSpotlight: async (repoId, worktreeId) => {
      const result = await window.api.spotlight.activate({ repoId, worktreeId })
      applyState(repoId, result.state)
      if (result.ok) {
        toast.success(
          translate(
            'auto.store.slices.spotlight.activated',
            'Spotlight on — the project root now mirrors this workspace'
          ),
          {
            description: translate(
              'auto.store.slices.spotlight.activatedLogs',
              'Server logs are mirrored for agents at .orca/spotlight.log'
            )
          }
        )
      } else {
        reportSpotlightError(
          translate('auto.store.slices.spotlight.activateFailed', 'Failed to start Spotlight'),
          result.error
        )
      }
      return result
    },

    syncSpotlight: async (repoId, opts) => {
      const previousErrorCode = get().spotlightByRepo[repoId]?.lastError?.code
      const result = await window.api.spotlight.sync({ repoId })
      applyState(repoId, result.state)
      // Silent mode also swallows 'not-active': a watcher-debounced sync can
      // land right after the user turned Spotlight off — that's not an error.
      if (opts?.silent && !result.ok && result.error.code === 'not-active') {
        return result
      }
      if (!result.ok && (!opts?.silent || result.error.code !== previousErrorCode)) {
        reportSpotlightError(
          translate('auto.store.slices.spotlight.syncFailed', 'Spotlight sync failed'),
          result.error
        )
      }
      return result
    },

    deactivateSpotlight: async (repoId) => {
      const result = await window.api.spotlight.deactivate({ repoId })
      applyState(repoId, result.state)
      if (result.ok) {
        toast.success(
          translate('auto.store.slices.spotlight.released', 'Spotlight off — project root restored')
        )
      } else {
        reportSpotlightError(
          translate('auto.store.slices.spotlight.deactivateFailed', 'Failed to turn off Spotlight'),
          result.error
        )
      }
      return result
    }
  }
}
