import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { normalizeGhAccountBinding } from '../../../../shared/github/account-binding'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import { REPO_UPDATE_EXECUTION_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'
import type { RepoSlice, RepoUpdate } from './repo-state'
import { repoWithFetchedOwner } from './owner-routing'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'
import {
  captureRepoUpdateOwner,
  findCapturedRepoUpdateOwner,
  repoUpdateResponseMatchesOwner
} from './repo-update-owner'

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
  if ('ghAccount' in sanitized && sanitized.ghAccount != null) {
    const normalized = normalizeGhAccountBinding(sanitized.ghAccount)
    if (!normalized) {
      delete sanitized.ghAccount
    } else {
      sanitized.ghAccount = normalized
    }
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
      const owner = captureRepoUpdateOwner(get(), projectId, options)
      if (!owner) {
        return false
      }
      const updateChainKey = owner.queueKey
      const applyRepoUpdate = async () => {
        try {
          const sanitizedUpdates = sanitizeRepoUpdate(updates)
          const target = owner.target
          if (target.kind === 'environment' && owner.qualified) {
            await assertRuntimeEnvironmentCapability(
              target.environmentId,
              REPO_UPDATE_EXECUTION_HOST_RUNTIME_CAPABILITY,
              'Update Orca on the server to safely change this project setup.',
              15_000
            )
          }
          if (!findCapturedRepoUpdateOwner(get(), owner)) {
            return false
          }
          const updatedRepo =
            target.kind === 'local'
              ? await window.api.repos.update({
                  repoId: projectId,
                  updates: sanitizedUpdates,
                  ...(owner.explicitHost ? { hostId: owner.rawHostId } : {})
                })
              : (
                  await callRuntimeRpc<{ repo: Repo }>(
                    target,
                    'repo.update',
                    {
                      repo: projectId,
                      updates: sanitizedUpdates,
                      ...(owner.qualified ? { executionHostId: owner.rawHostId } : {})
                    },
                    {
                      timeoutMs: 15_000,
                      expectedEnvironmentPairingRevision: owner.pairingRevision,
                      expectedEnvironmentRuntimeId: owner.runtimeId
                    }
                  )
                ).repo
          if (
            (owner.qualified && !updatedRepo) ||
            (updatedRepo && !repoUpdateResponseMatchesOwner(updatedRepo, owner))
          ) {
            return false
          }
          let applied = false
          set((s) => {
            const currentOwner = findCapturedRepoUpdateOwner(s, owner)
            if (!currentOwner) {
              return s
            }
            applied = true
            const nextRepos = s.repos.map((r) => {
              if (r !== currentOwner) {
                return r
              }
              if (updatedRepo) {
                return repoWithFetchedOwner(updatedRepo, target)
              }
              let mergedRepo: Repo = r
              const {
                sourceControlAi,
                externalWorktreeDiscoverySuppressedAt,
                ghAccount,
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
              if (ghAccount === null) {
                const { ghAccount: _ghAccount, ...repoWithoutGhAccount } = mergedRepo
                mergedRepo = repoWithoutGhAccount
              } else if (ghAccount !== undefined) {
                mergedRepo = { ...mergedRepo, ghAccount }
              }
              return mergedRepo
            })
            return {
              repos: nextRepos,
              ...mergeProjectCompatibilityForHostRepoChange({
                previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
                nextRepos,
                hostId: owner.publisherHostId
              }),
              folderWorkspacePathStatuses: {}
            }
          })
          return applied
        } catch (err) {
          console.error('Failed to update repo:', err)
          return false
        }
      }
      // A first legacy reply can add raw ownership while earlier edits are still queued.
      const previous =
        updateRepoChains.get(updateChainKey) ?? updateRepoChains.get(owner.legacyQueueKey)
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
