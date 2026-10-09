import type { StateCreator } from 'zustand'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { REPO_RELINK_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  parseRepoRelinkError,
  type RepoPathStatusEntry,
  type RepoRelinkErrorCode
} from '../../../../shared/repo-path-status'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '../../runtime/runtime-rpc-client'
import { findRepoForHost, repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { getProjectSetupRuntimeTarget } from '../projects/project-host-routing'
import { repoWithFetchedOwner, settingsForRepoOwner } from './owner-routing'

export type RepoRelinkOutcome =
  | { ok: true; repo: Repo }
  | { ok: false; code: RepoRelinkErrorCode | null; message: string }

export type RepoRelinkSlice = {
  /** Keyed by repo host identity. Absent means not checked yet; never "missing". */
  repoPathStatuses: Record<string, RepoPathStatusEntry>
  refreshRepoPathStatuses: (options?: { force?: boolean }) => Promise<void>
  relinkRepo: (
    repoId: string,
    path: string,
    options?: { hostId?: ExecutionHostId; force?: boolean }
  ) => Promise<RepoRelinkOutcome>
}

const RELINK_TIMEOUT_MS = 60_000

function runtimeEnvironmentIdsOf(repos: readonly Repo[]): string[] {
  const ids = new Set<string>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'runtime') {
      ids.add(parsed.environmentId)
    }
  }
  return [...ids]
}

async function fetchEnvironmentStatuses(
  environmentId: string,
  force: boolean
): Promise<RepoPathStatusEntry[] | null> {
  // Older servers lack the method; their repos simply stay unchecked.
  if (
    !(await runtimeEnvironmentSupportsCapability(environmentId, REPO_RELINK_RUNTIME_CAPABILITY))
  ) {
    return null
  }
  const { statuses } = await callRuntimeRpc<{ statuses: RepoPathStatusEntry[] }>(
    { kind: 'environment', environmentId },
    'repo.pathStatuses',
    { force },
    { timeoutMs: 30_000, suppressFeatureInteraction: true }
  )
  const hostId = toRuntimeExecutionHostId(environmentId)
  return statuses.map((entry) => ({ ...entry, hostId }))
}

function toRelinkFailure(error: unknown): RepoRelinkOutcome {
  const message = error instanceof Error ? error.message : String(error)
  const parsed = parseRepoRelinkError(message)
  return parsed
    ? { ok: false, code: parsed.code, message: parsed.detail }
    : { ok: false, code: null, message }
}

export function createRepoRelinkActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoRelinkSlice {
  return {
    repoPathStatuses: {},
    refreshRepoPathStatuses: async (options) => {
      const force = options?.force === true
      const sources: Promise<{ runtime: string | null; entries: RepoPathStatusEntry[] | null }>[] =
        [
          window.api.repos
            .getPathStatuses({ force })
            .then((entries) => ({ runtime: null, entries }))
            .catch(() => ({ runtime: null, entries: null }))
        ]
      for (const environmentId of runtimeEnvironmentIdsOf(get().repos)) {
        sources.push(
          fetchEnvironmentStatuses(environmentId, force)
            .then((entries) => ({ runtime: toRuntimeExecutionHostId(environmentId), entries }))
            .catch(() => ({ runtime: toRuntimeExecutionHostId(environmentId), entries: null }))
        )
      }
      const results = await Promise.all(sources)
      set((state) => {
        const next = { ...state.repoPathStatuses }
        for (const { runtime, entries } of results) {
          if (!entries) {
            continue
          }
          // A source that answered replaces every entry it owns, so a fixed repo clears.
          for (const [key, entry] of Object.entries(next)) {
            const isRuntimeEntry = parseExecutionHostId(entry.hostId)?.kind === 'runtime'
            if (runtime ? entry.hostId === runtime : !isRuntimeEntry) {
              delete next[key]
            }
          }
          for (const entry of entries) {
            next[getRepoHostIdentityForParts(entry.repoId, entry.hostId)] = entry
          }
        }
        return { repoPathStatuses: next }
      })
    },
    relinkRepo: async (repoId, path, options) => {
      const repo = findRepoForHost(get().repos, repoId, {
        settings: get().settings,
        hostId: options?.hostId
      })
      if (!repo) {
        return {
          ok: false,
          code: null,
          message: translate(
            'auto.store.repos.repoRelink.repoNotFound',
            'This repository is no longer registered.'
          )
        }
      }
      const hostId = getRepoExecutionHostId(repo)
      const explicitHost = Boolean(
        options?.hostId || repo.executionHostId?.trim() || repo.connectionId?.trim()
      )
      const target = explicitHost
        ? getProjectSetupRuntimeTarget(hostId)
        : getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      try {
        let updated: Repo
        if (target.kind === 'local') {
          updated = await window.api.repos.update({
            repoId,
            ...(explicitHost ? { hostId } : {}),
            ...(options?.force ? { forcePath: true } : {}),
            updates: { path }
          })
        } else {
          await assertRuntimeEnvironmentCapability(
            target.environmentId,
            REPO_RELINK_RUNTIME_CAPABILITY,
            translate(
              'auto.store.repos.repoRelink.serverUpdateRequired',
              'Update the Orca server to relink moved repositories.'
            )
          )
          const result = await callRuntimeRpc<{ repo: Repo }>(
            target,
            'repo.update',
            { repo: repoId, updates: { path }, ...(options?.force ? { forcePath: true } : {}) },
            { timeoutMs: RELINK_TIMEOUT_MS }
          )
          updated = result.repo
        }
        const owned = repoWithFetchedOwner(updated, target)
        set((state) => {
          const statuses = { ...state.repoPathStatuses }
          delete statuses[getRepoHostIdentityForParts(repoId, hostId)]
          return {
            repos: state.repos.map((candidate) =>
              repoMatchesHostIdentity(candidate, repoId, hostId) ? owned : candidate
            ),
            repoPathStatuses: statuses
          }
        })
        return { ok: true, repo: owned }
      } catch (error) {
        return toRelinkFailure(error)
      }
    }
  }
}
