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

/** Field-wise equality so applyState can skip a set when main re-sends an
 *  identical state (each op sends up to 3 events; an idle sync re-sends the same
 *  object). A no-op set would still churn every subscriber and invalidate the
 *  editor watch-target cache, which compares spotlightByRepo by reference. */
function spotlightStateEqual(a: SpotlightRepoState, b: SpotlightRepoState): boolean {
  return (
    a.holderWorktreeId === b.holderWorktreeId &&
    a.status === b.status &&
    a.originalBranch === b.originalBranch &&
    a.originalHeadSha === b.originalHeadSha &&
    a.backupSha === b.backupSha &&
    a.lastSnapshotSha === b.lastSnapshotSha &&
    a.activatedAt === b.activatedAt &&
    a.lastSyncAt === b.lastSyncAt &&
    a.lastError?.code === b.lastError?.code &&
    a.lastError?.message === b.lastError?.message
  )
}

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
    case 'untracked-collision':
      return translate(
        'auto.store.slices.spotlight.untrackedCollision',
        'Untracked files in the project root would be overwritten. Move or delete them, or force the sync.'
      )
    case 'not-enabled':
      return translate(
        'auto.store.slices.spotlight.notEnabled',
        'Spotlight testing is not enabled for this project.'
      )
    case 'bare-root':
    case 'branch-missing':
    case 'git-failed':
    case 'not-active':
    case 'not-on-primary-branch':
    case 'repo-not-found':
    case 'root-is-holder':
    case 'unborn-head':
    case 'worktree-not-found':
      return error.message
  }
}

function reportSpotlightError(
  title: string,
  error: SpotlightError,
  action?: { label: string; onClick: () => void }
): void {
  toast.error(title, {
    description: spotlightErrorDescription(error),
    duration: ERROR_TOAST_DURATION,
    ...(action ? { action } : {})
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
  /** Recovery for `root-diverged`: overwrite the root's outside changes with
   *  the holder workspace's snapshot. */
  forceSyncSpotlight: (repoId: string) => Promise<SpotlightOpResult>
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
      const current = s.spotlightByRepo[repoId]
      if (current && spotlightStateEqual(current, state)) {
        return {}
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
      if (!result.ok) {
        reportSpotlightError(
          translate('auto.store.slices.spotlight.activateFailed', 'Failed to start Spotlight'),
          result.error
        )
        return result
      }
      // Dynamic import: open-spotlight-terminal-tab imports this store, so a
      // static import would form an init-time cycle. Only claim log mirroring
      // when a terminal actually exists to feed it.
      const { openSpotlightTerminalTab } = await import('@/lib/open-spotlight-terminal-tab')
      const opened = openSpotlightTerminalTab({ repoId, reveal: false })
      if (opened.ok) {
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
        toast.success(
          translate(
            'auto.store.slices.spotlight.activatedNoTerminal',
            'Spotlight on — open the primary workspace and start your server there'
          )
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
          result.error,
          result.error.code === 'root-diverged'
            ? {
                label: translate('auto.store.slices.spotlight.forceSync', 'Force sync'),
                onClick: () => void get().forceSyncSpotlight(repoId)
              }
            : undefined
        )
      }
      return result
    },

    forceSyncSpotlight: async (repoId) => {
      const result = await window.api.spotlight.sync({ repoId, force: true })
      applyState(repoId, result.state)
      if (result.ok) {
        toast.success(
          translate(
            'auto.store.slices.spotlight.forceSynced',
            'Spotlight re-synced — the root mirrors the workspace again'
          )
        )
      } else if (result.error.code !== 'not-active') {
        // The root-diverged toast's "Force sync" action lives 60s; a click after
        // the user already turned Spotlight off returns 'not-active', which is
        // not a fresh failure worth toasting over the "Spotlight off" success.
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
      if (result.ok && result.leftDetachedFromBranch !== undefined) {
        // Root restored, but it couldn't return to its branch — warn instead of
        // a plain success so a detached root isn't a silent surprise.
        const branch = result.leftDetachedFromBranch
        toast.warning(
          translate(
            'auto.store.slices.spotlight.releasedDetached',
            'Spotlight off — project root left detached'
          ),
          {
            description: branch
              ? translate(
                  'auto.store.slices.spotlight.releasedDetachedInUse',
                  'Its branch "{{branch}}" is checked out in another workspace, so the root could not switch back to it. Free that branch (or check out any branch in the root) to re-attach.'
                ).replace('{{branch}}', branch)
              : translate(
                  'auto.store.slices.spotlight.releasedDetachedGone',
                  "The root's original branch no longer exists, so it was left detached at its original commit."
                ),
            duration: ERROR_TOAST_DURATION
          }
        )
      } else if (result.ok) {
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
