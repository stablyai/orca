import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import {
  findRepoForHost,
  getRepoHostIdentityForParts,
  repoMatchesHostIdentity
} from '../slices/repo-host-identity'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'
import type { RepoSlice, RepoUpdate } from './repo-state'
import { repoWithFetchedOwner, settingsForRepoOwner } from './owner-routing'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { getProjectSetupRuntimeTarget } from '../projects/project-host-routing'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'

export function sanitizeRepoUpdate(updates: RepoUpdate): RepoUpdate {
  const sanitized = { ...updates }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
  }
  if (
    'forkSyncMode' in sanitized &&
    sanitized.forkSyncMode !== undefined &&
    sanitized.forkSyncMode !== 'ask' &&
    sanitized.forkSyncMode !== 'safe-auto' &&
    sanitized.forkSyncMode !== 'off'
  ) {
    delete sanitized.forkSyncMode
  }
  if ('customWorktreeVisibilitySources' in sanitized) {
    const sources = normalizeCustomWorktreeVisibilitySources(
      sanitized.customWorktreeVisibilitySources
    )
    if (!sources) {
      delete sanitized.customWorktreeVisibilitySources
    } else {
      sanitized.customWorktreeVisibilitySources = sources
    }
  }
  if ('worktreeVisibilitySourcePreferences' in sanitized) {
    const preferences = normalizeWorktreeVisibilitySourcePreferences(
      sanitized.worktreeVisibilitySourcePreferences
    )
    if (!preferences) {
      delete sanitized.worktreeVisibilitySourcePreferences
    } else {
      sanitized.worktreeVisibilitySourcePreferences = preferences
    }
  }
  return sanitized
}

export const updateRepoChainsByStore = new WeakMap<() => AppState, Map<string, Promise<boolean>>>()

export function getRepoUpdateChains(get: () => AppState): Map<string, Promise<boolean>> {
  let chains = updateRepoChainsByStore.get(get)
  if (!chains) {
    chains = new Map<string, Promise<boolean>>()
    updateRepoChainsByStore.set(get, chains)
  }
  return chains
}

export function createRepoUpdateActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'updateRepo'> {
  return {
    updateRepo: async (projectId, updates, options) => {
      const updateRepoChains = getRepoUpdateChains(get)
      // Why: pass options.hostId so a duplicate repo id across hosts resolves to the intended row, not the settings-focused fallback.
      const ownerRepo = findRepoForHost(get().repos, projectId, {
        settings: get().settings,
        hostId: options?.hostId
      })
      if (!ownerRepo) {
        return false
      }
      // Why: an explicit hostId is authoritative; route to that host's target rather than the currently-focused runtime.
      const ownerHasExplicitHost = Boolean(
        options?.hostId || ownerRepo.executionHostId?.trim() || ownerRepo.connectionId?.trim()
      )
      const explicitOwnerHostId = getRepoExecutionHostId(ownerRepo)
      const ownerTarget = ownerHasExplicitHost
        ? getProjectSetupRuntimeTarget(explicitOwnerHostId)
        : getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId))
      const ownerHostId = ownerHasExplicitHost
        ? explicitOwnerHostId
        : getRuntimeTargetHostId(ownerTarget)
      const updateChainKey = getRepoHostIdentityForParts(projectId, ownerHostId)
      const applyRepoUpdate = async () => {
        try {
          const sanitizedUpdates = sanitizeRepoUpdate(updates)
          const target = ownerTarget
          const updatedRepo =
            target.kind === 'local'
              ? await window.api.repos.update({
                  repoId: projectId,
                  updates: sanitizedUpdates,
                  ...(ownerHasExplicitHost ? { hostId: ownerHostId } : {})
                })
              : (
                  await callRuntimeRpc<{ repo: Repo }>(
                    target,
                    'repo.update',
                    { repo: projectId, updates: sanitizedUpdates },
                    { timeoutMs: 15_000 }
                  )
                ).repo
          set((s) => {
            const nextRepos = s.repos.map((r) => {
              const matchesOwner = ownerHasExplicitHost
                ? repoMatchesHostIdentity(r, projectId, ownerHostId)
                : repoMatchesHostIdentity(r, projectId, ownerHostId) || r === ownerRepo
              if (!matchesOwner) {
                return r
              }
              if (updatedRepo) {
                return repoWithFetchedOwner(updatedRepo, target)
              }
              let mergedRepo: Repo = r
              const {
                sourceControlAi,
                externalWorktreeDiscoverySuppressedAt,
                externalWorktreeVisibility,
                agentWorktreeVisibility,
                ...updatesWithoutClearSentinels
              } = sanitizedUpdates
              mergedRepo = { ...mergedRepo, ...updatesWithoutClearSentinels }
              if (sourceControlAi === null) {
                const { sourceControlAi: _sourceControlAi, ...repoWithoutSourceControlAi } =
                  mergedRepo
                mergedRepo = repoWithoutSourceControlAi
              } else if (sourceControlAi !== undefined) {
                mergedRepo = { ...mergedRepo, sourceControlAi }
              }
              if (externalWorktreeVisibility === null) {
                const { externalWorktreeVisibility: _visibility, ...repoWithoutVisibility } =
                  mergedRepo
                mergedRepo = { ...repoWithoutVisibility, externalWorktreeVisibilityLegacy: false }
              } else if (externalWorktreeVisibility !== undefined) {
                mergedRepo = { ...mergedRepo, externalWorktreeVisibility }
              }
              if (agentWorktreeVisibility === null) {
                const { agentWorktreeVisibility: _agentVisibility, ...repoWithoutAgentVisibility } =
                  mergedRepo
                mergedRepo = repoWithoutAgentVisibility
              } else if (agentWorktreeVisibility !== undefined) {
                mergedRepo = { ...mergedRepo, agentWorktreeVisibility }
              }
              if (externalWorktreeDiscoverySuppressedAt === null) {
                const {
                  externalWorktreeDiscoverySuppressedAt: _suppressedAt,
                  ...repoWithoutSuppression
                } = mergedRepo
                mergedRepo = repoWithoutSuppression
              } else if (externalWorktreeDiscoverySuppressedAt !== undefined) {
                mergedRepo = { ...mergedRepo, externalWorktreeDiscoverySuppressedAt }
              }
              return mergedRepo
            })
            return {
              repos: nextRepos,
              ...mergeProjectCompatibilityForHostRepoChange({
                previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
                nextRepos,
                hostId: ownerHostId
              }),
              folderWorkspacePathStatuses: {}
            }
          })
          return true
        } catch (err) {
          console.error('Failed to update repo:', err)
          return false
        }
      }
      const previous = updateRepoChains.get(updateChainKey)
      // Why: settings persist as full nested values, so preserve per-repo call order — a slower response mustn't overwrite newer state.
      const next = previous
        ? previous.catch(() => undefined).then(applyRepoUpdate)
        : applyRepoUpdate()
      updateRepoChains.set(updateChainKey, next)
      const cleanup = () => {
        if (updateRepoChains.get(updateChainKey) === next) {
          updateRepoChains.delete(updateChainKey)
        }
      }
      void next.then(cleanup, cleanup)
      return next
    }
  }
}
