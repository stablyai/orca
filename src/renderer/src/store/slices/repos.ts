/* eslint-disable max-lines -- Why: repo slice owns local/runtime routing,
add/remove/reorder side effects, and cross-slice teardown. Splitting it during
the client-server refactor would obscure the invariants this file is currently
auditing and preserving. */
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { buildDismissedOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'

const ERROR_TOAST_DURATION = 60_000

type RepoUpdate = Partial<
  Pick<
    Repo,
    | 'displayName'
    | 'badgeColor'
    | 'hookSettings'
    | 'worktreeBaseRef'
    | 'kind'
    | 'symlinkPaths'
    | 'issueSourcePreference'
  >
>

const updateRepoChainsByStore = new WeakMap<() => AppState, Map<string, Promise<boolean>>>()

function getRepoUpdateChains(get: () => AppState): Map<string, Promise<boolean>> {
  let chains = updateRepoChainsByStore.get(get)
  if (!chains) {
    chains = new Map<string, Promise<boolean>>()
    updateRepoChainsByStore.set(get, chains)
  }
  return chains
}

export type RepoSlice = {
  repos: Repo[]
  activeRepoId: string | null
  fetchRepos: () => Promise<void>
  addRepo: () => Promise<Repo | null>
  addRepoPath: (path: string, kind?: 'git' | 'folder') => Promise<Repo | null>
  addNonGitFolder: (path: string) => Promise<Repo | null>
  removeRepo: (repoId: string) => Promise<void>
  updateRepo: (repoId: string, updates: RepoUpdate) => Promise<boolean>
  setActiveRepo: (repoId: string | null) => void
  reorderRepos: (orderedIds: string[]) => Promise<void>
}

export const createRepoSlice: StateCreator<AppState, [], [], RepoSlice> = (set, get) => ({
  repos: [],
  activeRepoId: null,

  fetchRepos: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const repos =
        target.kind === 'local'
          ? ((await window.api.repos.list()) as Repo[])
          : (
              await callRuntimeRpc<{ repos: Repo[] }>(
                target,
                'repo.list',
                undefined,
                // Why: remote environment fetches cross the network; keep the
                // boot-time repo hydration bounded instead of inheriting an
                // unbounded renderer promise.
                { timeoutMs: 15_000 }
              )
            ).repos
      set((s) => {
        const validRepoIds = new Set(repos.map((repo) => repo.id))
        return {
          repos,
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((repoId) => validRepoIds.has(repoId)),
          setupScriptPromptDismissedRepoIds: s.setupScriptPromptDismissedRepoIds.filter((repoId) =>
            validRepoIds.has(repoId)
          )
        }
      })
    } catch (err) {
      console.error('Failed to fetch repos:', err)
    }
  },

  addRepoPath: async (path, kind = 'git') => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      let repo: Repo
      try {
        if (target.kind === 'local') {
          const result = await window.api.repos.add({ path, kind })
          if ('error' in result) {
            throw new Error(result.error)
          }
          repo = result.repo
        } else {
          repo = (
            await callRuntimeRpc<{ repo: Repo }>(
              target,
              'repo.add',
              { path, kind },
              { timeoutMs: 15_000 }
            )
          ).repo
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (kind !== 'git' || !message.includes('Not a valid git repository')) {
          throw err
        }
        // Why: folder mode is a capability downgrade, not a silent fallback.
        // Show an in-app confirmation dialog so users understand that worktrees,
        // SCM, PRs, and checks will be unavailable for this root. The dialog's
        // OK handler calls addNonGitFolder to complete the flow.
        const { openModal } = get()
        openModal('confirm-non-git-folder', { folderPath: path })
        return null
      }
      const alreadyAdded = get().repos.some((r) => r.id === repo.id)
      if (alreadyAdded) {
        get().clearOrcaHookTrustForRepo(repo.id)
      }
      set((s) => {
        if (s.repos.some((r) => r.id === repo.id)) {
          return s
        }
        return { repos: [...s.repos, repo] }
      })
      if (alreadyAdded) {
        toast.info('Project already added', { description: repo.displayName })
      } else {
        toast.success(isGitRepoKind(repo) ? 'Project added' : 'Folder added', {
          description: repo.displayName
        })
      }
      return repo
    } catch (err) {
      console.error('Failed to add project:', err)
      const message = err instanceof Error ? err.message : String(err)
      const duration = ERROR_TOAST_DURATION
      toast.error('Failed to add project', {
        description: message,
        duration
      })
      return null
    }
  },

  addRepo: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'local') {
      // Why: OS folder pickers return client-local paths. Remote environments
      // need an explicit server path, which the Add Project dialog handles.
      toast.error('Use a server path to add projects from a remote runtime.')
      return null
    }
    const path = await window.api.repos.pickFolder()
    if (!path) {
      return null
    }
    return get().addRepoPath(path)
  },

  addNonGitFolder: async (path) => {
    try {
      const hadProjectBeforeAdd = get().repos.length > 0
      const repo = await get().addRepoPath(path, 'folder')
      if (!repo) {
        return null
      }
      // Why: without focusing the new folder, the UI looks unchanged after
      // the dialog closes and users think nothing happened. Fetch the
      // synthetic folder worktree and route through the standard activation
      // sequence so the sidebar reveals and opens the folder the same way
      // clicking a worktree card does. Lazy-imported to avoid a circular
      // module load (worktree-activation imports the store root).
      await get().fetchWorktrees(repo.id)
      const folderWorktree = get().worktreesByRepo[repo.id]?.[0]
      if (folderWorktree) {
        const { activateAndRevealWorktree } = await import('../../lib/worktree-activation')
        const onboarding = await window.api.onboarding.get().catch(() => null)
        // Why: a new user can dismiss the wizard, then immediately add their
        // first folder from Landing. That path skips onboarding's completeRepo
        // hook, so carry the selected default agent into the first terminal here.
        const startup = buildDismissedOnboardingFolderAgentStartup(
          get().settings,
          onboarding,
          hadProjectBeforeAdd
        )
        activateAndRevealWorktree(folderWorktree.id, startup ? { startup } : undefined)
      }
      return repo
    } catch (err) {
      console.error('Failed to add folder:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Failed to add folder', { description: message, duration: ERROR_TOAST_DURATION })
      return null
    }
  },

  removeRepo: async (repoId) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      await (target.kind === 'local'
        ? window.api.repos.remove({ repoId })
        : callRuntimeRpc(target, 'repo.rm', { repo: repoId }, { timeoutMs: 15_000 }))

      get().clearOrcaHookTrustForRepo(repoId)
      const repoPath = get().repos.find((repo) => repo.id === repoId)?.path
      get().evictGitHubRepoCaches(repoId, repoPath)
      const { clearRepoSlugCacheEntry } = await import('../../lib/repo-slug-index')
      clearRepoSlugCacheEntry(repoId)

      // Kill PTYs for all worktrees belonging to this repo
      const worktreeIds = (get().worktreesByRepo[repoId] ?? []).map((w) => w.id)
      const killedTabIds = new Set<string>()
      const killedPtyIds = new Set<string>()
      if (target.kind === 'environment') {
        await Promise.allSettled(
          worktreeIds.map((worktreeId) =>
            callRuntimeRpc(target, 'terminal.stop', { worktree: worktreeId }, { timeoutMs: 15_000 })
          )
        )
      }
      for (const wId of worktreeIds) {
        const tabs = get().tabsByWorktree[wId] ?? []
        for (const tab of tabs) {
          killedTabIds.add(tab.id)
          for (const ptyId of get().ptyIdsByTabId[tab.id] ?? []) {
            killedPtyIds.add(ptyId)
            if (!ptyId.startsWith('remote:')) {
              window.api.pty.kill(ptyId)
            }
          }
        }
      }

      set((s) => {
        const nextWorktrees = { ...s.worktreesByRepo }
        delete nextWorktrees[repoId]
        const nextTabs = { ...s.tabsByWorktree }
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
        for (const wId of worktreeIds) {
          delete nextTabs[wId]
        }
        for (const tabId of killedTabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
        }
        for (const ptyId of killedPtyIds) {
          nextSuppressedPtyExitIds[ptyId] = true
        }
        // Why: editor state is worktree-scoped. Removing a repo must also
        // remove open editor files and per-worktree active-file tracking for
        // all worktrees that belonged to the repo, otherwise orphaned entries
        // would persist in the session save and pollute state.
        const worktreeIdSet = new Set(worktreeIds)
        const nextOpenFiles = s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        for (const wId of worktreeIds) {
          delete nextActiveFileIdByWorktree[wId]
          delete nextActiveTabTypeByWorktree[wId]
        }
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && worktreeIdSet.has(f.worktreeId))
          : false
        // Why: pruneLastVisitedTimestamps defers entries for repos missing
        // from worktreesByRepo (treats them as not-yet-hydrated SSH repos).
        // Drop this repo's timestamps explicitly so they cannot survive prune
        // forever after the repo is removed.
        let nextLastVisitedAtByWorktreeId = s.lastVisitedAtByWorktreeId
        for (const id of Object.keys(s.lastVisitedAtByWorktreeId)) {
          if (getRepoIdFromWorktreeId(id) === repoId) {
            if (nextLastVisitedAtByWorktreeId === s.lastVisitedAtByWorktreeId) {
              nextLastVisitedAtByWorktreeId = { ...s.lastVisitedAtByWorktreeId }
            }
            delete nextLastVisitedAtByWorktreeId[id]
          }
        }
        const nextRepos = s.repos.filter((r) => r.id !== repoId)
        return {
          repos: nextRepos,
          activeRepoId: s.activeRepoId === repoId ? null : s.activeRepoId,
          filterRepoIds: s.filterRepoIds.filter((id) => id !== repoId),
          worktreesByRepo: nextWorktrees,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          suppressedPtyExitIds: nextSuppressedPtyExitIds,
          terminalLayoutsByTabId: nextLayouts,
          activeTabId: s.activeTabId && killedTabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: nextOpenFiles,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeTabType: activeFileCleared ? 'terminal' : s.activeTabType,
          lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
          sortEpoch: s.sortEpoch + 1,
          // Why: removing the last repo while in settings leaves activeView as
          // 'settings', which renders an empty settings pane instead of Landing.
          // Also clear activeWorktreeId so App renders Landing (it checks
          // !activeWorktreeId). Without this, the terminal surface shows instead.
          ...(nextRepos.length === 0
            ? {
                activeView: 'terminal' as const,
                activeWorktreeId: null,
                activeRepoId: null
              }
            : {})
        }
      })
    } catch (err) {
      console.error('Failed to remove repo:', err)
    }
  },

  updateRepo: async (repoId, updates) => {
    const updateRepoChains = getRepoUpdateChains(get)
    const applyRepoUpdate = async () => {
      try {
        const target = getActiveRuntimeTarget(get().settings)
        await (target.kind === 'local'
          ? window.api.repos.update({ repoId, updates })
          : callRuntimeRpc(target, 'repo.update', { repo: repoId, updates }, { timeoutMs: 15_000 }))
        set((s) => ({
          repos: s.repos.map((r) => (r.id === repoId ? { ...r, ...updates } : r))
        }))
        return true
      } catch (err) {
        console.error('Failed to update repo:', err)
        return false
      }
    }
    const previous = updateRepoChains.get(repoId)
    // Why: repo settings are persisted as full nested values. Preserve call
    // order per repo so a slower IPC/RPC response cannot overwrite newer state.
    const next = previous
      ? previous.catch(() => undefined).then(applyRepoUpdate)
      : applyRepoUpdate()
    updateRepoChains.set(repoId, next)
    const cleanup = () => {
      if (updateRepoChains.get(repoId) === next) {
        updateRepoChains.delete(repoId)
      }
    }
    void next.then(cleanup, cleanup)
    return next
  },

  setActiveRepo: (repoId) => set({ activeRepoId: repoId }),

  reorderRepos: async (orderedIds) => {
    // Optimistically apply the new order so the sidebar updates instantly;
    // resync only if main rejects (stale permutation due to a racing add/remove).
    const previous = get().repos
    const byId = new Map(previous.map((r) => [r.id, r]))
    const next: Repo[] = []
    for (const id of orderedIds) {
      const repo = byId.get(id)
      if (repo) {
        next.push(repo)
      }
    }
    if (next.length !== previous.length) {
      // Caller passed a non-permutation — refuse to apply locally.
      return
    }
    set({ repos: next })
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const result =
        target.kind === 'local'
          ? await window.api.repos.reorder({ orderedIds })
          : await callRuntimeRpc<{ status: 'applied' | 'rejected' }>(
              target,
              'repo.reorder',
              { orderedIds },
              { timeoutMs: 15_000 }
            )
      if (result.status === 'rejected') {
        await get().fetchRepos()
      }
    } catch (err) {
      console.error('Failed to reorder repos:', err)
      await get().fetchRepos()
    }
  }
})
