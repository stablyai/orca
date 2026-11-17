import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { findRepoForHost, repoMatchesHostIdentity } from './repo-host-identity'
import { getRepoHostIdentityForParts } from '../../../../shared/repository/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RepoSlice } from './repo-state'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { getProjectSetupRuntimeTarget } from '../projects/project-host-routing'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'
import { applySanitizedRepoUpdateFallback, sanitizeRepoUpdate } from './repo-update-sanitization'
import {
  notifyProjectPinFailed,
  notifyProjectPinRejected
} from '../project-groups/project-group-mutation-toasts'

export { sanitizeRepoUpdate }

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
        if (updates.isPinned !== undefined) {
          notifyProjectPinFailed()
        }
        return false
      }
      // Why: an explicit hostId is authoritative; route to that host's target rather than the currently-focused runtime.
      const ownerHasExplicitHost = Boolean(
        options?.hostId || ownerRepo.executionHostId?.trim() || ownerRepo.connectionId?.trim()
      )
      // Why: a row with no stamp is this app's own; ingest stamps every server row.
      const ownerHostId = getRepoExecutionHostId(ownerRepo)
      const ownerTarget = getProjectSetupRuntimeTarget(ownerHostId)
      const updateChainKey = getRepoHostIdentityForParts(projectId, ownerHostId)
      const applyRepoUpdate = async () => {
        // Why at dispatch: an earlier queued update (an account change) may legitimately replace the owner.
        const sourceOwner = get().githubSourceCollections?.capture(
          get().repos.find((r) => repoMatchesHostIdentity(r, projectId, ownerHostId)) ?? ownerRepo
        )
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
          if (
            sanitizedUpdates.projectGroupOrder !== undefined &&
            (!updatedRepo ||
              (updatedRepo.projectGroupOrder ?? null) !== sanitizedUpdates.projectGroupOrder)
          ) {
            return false
          }
          // A host from before dictionaries drops the field and still answers with its row.
          if (
            sanitizedUpdates.dictationTerms !== undefined &&
            JSON.stringify(updatedRepo?.dictationTerms ?? []) !==
              JSON.stringify(sanitizedUpdates.dictationTerms)
          ) {
            return false
          }
          // A host from before hidden projects drops the field, which would otherwise read as hidden.
          if (
            sanitizedUpdates.hiddenAt !== undefined &&
            (updatedRepo?.hiddenAt ?? null) !== sanitizedUpdates.hiddenAt
          ) {
            return false
          }
          // A host from before per-repo browser profiles drops the field and still answers with its row.
          if (
            sanitizedUpdates.browserProfileId !== undefined &&
            (updatedRepo?.browserProfileId ?? null) !== sanitizedUpdates.browserProfileId
          ) {
            return false
          }
          if (
            sanitizedUpdates.isPinned !== undefined &&
            (!updatedRepo || updatedRepo.isPinned !== sanitizedUpdates.isPinned)
          ) {
            if (updatedRepo) {
              notifyProjectPinRejected()
            } else {
              notifyProjectPinFailed()
            }
            return false
          }
          set((s) => {
            const nextRepos = s.repos.map((r) => {
              const matchesOwner = ownerHasExplicitHost
                ? repoMatchesHostIdentity(r, projectId, ownerHostId)
                : repoMatchesHostIdentity(r, projectId, ownerHostId) || r === ownerRepo
              if (!matchesOwner) {
                return r
              }
              if (sourceOwner && !s.githubSourceCollections?.owns(sourceOwner)) {
                return r
              }
              if (updatedRepo) {
                return (
                  s.githubSourceCollections?.adopt(
                    adoptFromEndpoint(target, { kind: 'repo', row: updatedRepo })
                  ) ?? adoptFromEndpoint(target, { kind: 'repo', row: updatedRepo })
                )
              }
              const mergedRepo = applySanitizedRepoUpdateFallback(r, sanitizedUpdates)
              return s.githubSourceCollections?.adopt(mergedRepo) ?? mergedRepo
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
          if (updates.isPinned !== undefined) {
            notifyProjectPinFailed()
          }
          return false
        }
      }
      const previous = updateRepoChains.get(updateChainKey)
      // Persisted nested settings replace whole values; serialize per repo so slow replies cannot overwrite newer edits.
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
