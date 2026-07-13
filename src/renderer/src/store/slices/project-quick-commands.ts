import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { getProjectTerminalQuickCommands } from '../../../../shared/terminal-quick-commands'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'

export type ProjectQuickCommandsSlice = {
  /** Repo-scoped quick commands projected from each repo's orca.yaml
   *  `quickCommands` key. Lazily populated by `loadProjectQuickCommands`;
   *  missing key means "not yet fetched", empty array means "none defined". */
  projectQuickCommandsByRepo: Record<string, TerminalQuickCommand[]>
  loadProjectQuickCommands: (repoId: string, opts?: { refresh?: boolean }) => Promise<void>
}

// Why: in-flight guards live outside the store — promises are not
// serializable state, and a module map keeps repeat callers coalesced.
const inFlightByRepo = new Map<string, Promise<void>>()

export function __resetProjectQuickCommandsFetchesForTests(): void {
  inFlightByRepo.clear()
}

type ProjectQuickCommandsMaps = Pick<AppState, 'projectQuickCommandsByRepo'>

// Why: like sparse presets, the per-repo cache is populated lazily but must not
// outlive the repo. Called from the repo-removal reducers.
export function omitProjectQuickCommandsForRepos(
  s: ProjectQuickCommandsMaps,
  removedRepoIds: Iterable<string>
): Partial<AppState> {
  const removed = removedRepoIds instanceof Set ? removedRepoIds : new Set(removedRepoIds)
  if (removed.size === 0) {
    return {}
  }
  let changed = false
  const out = { ...s.projectQuickCommandsByRepo }
  for (const id of removed) {
    if (id in out) {
      delete out[id]
      changed = true
    }
  }
  return changed ? { projectQuickCommandsByRepo: out } : {}
}

export const createProjectQuickCommandsSlice: StateCreator<
  AppState,
  [],
  [],
  ProjectQuickCommandsSlice
> = (set, get) => ({
  projectQuickCommandsByRepo: {},

  loadProjectQuickCommands: async (repoId, opts) => {
    if (!repoId) {
      return
    }
    const cached = get().projectQuickCommandsByRepo[repoId]
    if (cached !== undefined && !opts?.refresh) {
      return
    }
    const existing = inFlightByRepo.get(repoId)
    if (existing) {
      return existing
    }
    const fetchPromise = (async () => {
      const state = get()
      // Why: orca.yaml must be read from the host that owns the repo (local,
      // SSH, or runtime), not from the currently focused runtime.
      const ownerSettings = getSettingsForRepoRuntimeOwner(state, repoId)
      const result = await checkRuntimeHooks(ownerSettings, repoId)
      if (result.status === 'error') {
        // Why: keep any previous snapshot on transient errors (offline SSH
        // host); only a successful read may change what the menu shows.
        return
      }
      const commands = getProjectTerminalQuickCommands(result.hooks?.quickCommands, repoId)
      set((s) => ({
        projectQuickCommandsByRepo: { ...s.projectQuickCommandsByRepo, [repoId]: commands }
      }))
    })().catch((err: unknown) => {
      console.warn(`Failed to load project quick commands for repo ${repoId}:`, err)
    })
    inFlightByRepo.set(repoId, fetchPromise)
    try {
      await fetchPromise
    } finally {
      inFlightByRepo.delete(repoId)
    }
  }
})
