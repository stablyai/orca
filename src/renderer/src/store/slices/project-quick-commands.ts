import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalQuickCommand } from '../../../../shared/types'
import {
  getProjectTerminalQuickCommands,
  terminalQuickCommandListsMatch
} from '../../../../shared/terminal-quick-commands'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { getRepoHostIdentity } from './repo-host-identity'

export type ProjectQuickCommandsSlice = {
  /** Repo-scoped quick commands projected from each repo's orca.yaml
   *  `quickCommands` key. Lazily populated by `loadProjectQuickCommands`;
   *  missing key means "not yet fetched", empty array means "none defined". */
  projectQuickCommandsByRepo: Record<string, TerminalQuickCommand[]>
  projectQuickCommandOwnerByRepo: Record<string, string>
  loadProjectQuickCommands: (repoId: string, opts?: { refresh?: boolean }) => Promise<void>
}

// Why: in-flight guards live outside the store — promises are not
// serializable state, and a module map keeps repeat callers coalesced.
const inFlightByOwner = new Map<string, Promise<void>>()

export function __resetProjectQuickCommandsFetchesForTests(): void {
  inFlightByOwner.clear()
}

type ProjectQuickCommandsMaps = Pick<
  AppState,
  'projectQuickCommandsByRepo' | 'projectQuickCommandOwnerByRepo'
>

type ProjectQuickCommandsCacheState = ProjectQuickCommandsMaps & Pick<AppState, 'repos'>

// Why: Zustand selectors run on every store write; cache the owner index by
// repos-array identity so terminal/status churn does not repeatedly scan repos.
const uniqueOwnerIdentityByRepos = new WeakMap<
  ProjectQuickCommandsCacheState['repos'],
  ReadonlyMap<string, string | null>
>()

function getUniqueOwnerIdentityByRepo(
  repos: ProjectQuickCommandsCacheState['repos']
): ReadonlyMap<string, string | null> {
  const cached = uniqueOwnerIdentityByRepos.get(repos)
  if (cached) {
    return cached
  }
  const owners = new Map<string, string | null>()
  for (const repo of repos) {
    owners.set(repo.id, owners.has(repo.id) ? null : getRepoHostIdentity(repo))
  }
  uniqueOwnerIdentityByRepos.set(repos, owners)
  return owners
}

export function selectProjectQuickCommandsForRepo(
  state: ProjectQuickCommandsCacheState,
  repoId: string
): TerminalQuickCommand[] | undefined {
  const ownerIdentity = getUniqueOwnerIdentityByRepo(state.repos).get(repoId)
  if (!ownerIdentity || state.projectQuickCommandOwnerByRepo[repoId] !== ownerIdentity) {
    return undefined
  }
  return state.projectQuickCommandsByRepo[repoId]
}

export function selectProjectQuickCommandsForOpenMenu(
  state: ProjectQuickCommandsCacheState,
  repoId: string | null,
  menuOpen: boolean
): TerminalQuickCommand[] | undefined {
  // Why: TerminalPane is expensive and always mounted; closed context menus
  // must stay referentially stable across project-command cache writes.
  return menuOpen && repoId !== null ? selectProjectQuickCommandsForRepo(state, repoId) : undefined
}

export function collectProjectQuickCommandsForRepos(
  state: ProjectQuickCommandsCacheState
): TerminalQuickCommand[] {
  const commands: TerminalQuickCommand[] = []
  for (const [repoId, ownerIdentity] of getUniqueOwnerIdentityByRepo(state.repos)) {
    if (ownerIdentity && state.projectQuickCommandOwnerByRepo[repoId] === ownerIdentity) {
      commands.push(...(state.projectQuickCommandsByRepo[repoId] ?? []))
    }
  }
  return commands
}

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
  let commandsChanged = false
  let ownersChanged = false
  const commands = { ...s.projectQuickCommandsByRepo }
  const owners = { ...s.projectQuickCommandOwnerByRepo }
  for (const id of removed) {
    if (id in commands) {
      delete commands[id]
      commandsChanged = true
    }
    if (id in owners) {
      delete owners[id]
      ownersChanged = true
    }
  }
  return {
    ...(commandsChanged ? { projectQuickCommandsByRepo: commands } : {}),
    ...(ownersChanged ? { projectQuickCommandOwnerByRepo: owners } : {})
  }
}

export const createProjectQuickCommandsSlice: StateCreator<
  AppState,
  [],
  [],
  ProjectQuickCommandsSlice
> = (set, get) => ({
  projectQuickCommandsByRepo: {},
  projectQuickCommandOwnerByRepo: {},

  loadProjectQuickCommands: async (repoId, opts) => {
    if (!repoId) {
      return
    }
    // Why: duplicate bare repo ids cannot be routed to one owner host (see
    // findRepoOwner); a bare-id cache could serve another host's commands, so
    // skip loading and drop any cached bucket until the ambiguity clears.
    const owners = get().repos.filter((repo) => repo.id === repoId)
    if (owners.length !== 1) {
      set((s) => {
        const omitted = omitProjectQuickCommandsForRepos(s, [repoId])
        return omitted.projectQuickCommandsByRepo || omitted.projectQuickCommandOwnerByRepo
          ? omitted
          : s
      })
      return
    }
    const ownerIdentity = getRepoHostIdentity(owners[0])
    const cachedState = get()
    const cached = cachedState.projectQuickCommandsByRepo[repoId]
    const cachedOwner = cachedState.projectQuickCommandOwnerByRepo[repoId]
    if (cached !== undefined && cachedOwner === ownerIdentity && !opts?.refresh) {
      return
    }
    if (cachedOwner !== undefined && cachedOwner !== ownerIdentity) {
      set((s) => omitProjectQuickCommandsForRepos(s, [repoId]))
    }
    const existing = inFlightByOwner.get(ownerIdentity)
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
      set((s) => {
        const currentOwners = s.repos.filter((repo) => repo.id === repoId)
        if (currentOwners.length !== 1) {
          // Why: a removal/collision while the read was in flight must not
          // resurrect an orphaned or ambiguously owned cache bucket.
          const omitted = omitProjectQuickCommandsForRepos(s, [repoId])
          return omitted.projectQuickCommandsByRepo || omitted.projectQuickCommandOwnerByRepo
            ? omitted
            : s
        }
        if (getRepoHostIdentity(currentOwners[0]) !== ownerIdentity) {
          // Why: a replacement owner may already have published its own read;
          // the stale request must neither overwrite nor delete that snapshot.
          return s
        }
        if (
          s.projectQuickCommandOwnerByRepo[repoId] === ownerIdentity &&
          terminalQuickCommandListsMatch(s.projectQuickCommandsByRepo[repoId], commands)
        ) {
          // Why: menu-open revalidation is common; preserving the array keeps
          // unchanged reads from re-rendering the large TerminalPane tree.
          return s
        }
        return {
          projectQuickCommandsByRepo: { ...s.projectQuickCommandsByRepo, [repoId]: commands },
          projectQuickCommandOwnerByRepo: {
            ...s.projectQuickCommandOwnerByRepo,
            [repoId]: ownerIdentity
          }
        }
      })
    })().catch((err: unknown) => {
      console.warn(`Failed to load project quick commands for repo ${repoId}:`, err)
    })
    inFlightByOwner.set(ownerIdentity, fetchPromise)
    try {
      await fetchPromise
    } finally {
      if (inFlightByOwner.get(ownerIdentity) === fetchPromise) {
        inFlightByOwner.delete(ownerIdentity)
      }
    }
  }
})
