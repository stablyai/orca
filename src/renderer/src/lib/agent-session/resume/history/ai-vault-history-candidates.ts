import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { createWorktreeTabBucketProjection } from '@/lib/workspace/tabs/worktree-tab-bucket-projection'
import type { AppState } from '@/store/types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { normalizeWorktreeVisibilitySourcePreferences } from '../../../../../../shared/worktree/visibility-sources'
import type { Worktree, DetectedWorktree } from '../../../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { normalizeExecutionHostId } from '../../../../../../shared/execution-host'
import {
  aiVaultHistoryWorktrees,
  aiVaultHistoryRecordWorktrees,
  type AiVaultHistoryVisibilitySettings
} from './ai-vault-history-worktrees'

type Listing = AppState['detectedWorktreesByRepo'][string]
type Inputs = Pick<AppState, 'detectedWorktreesByRepo' | 'repos' | 'settings'>

function sameCandidate(previous: Worktree, next: Worktree): boolean {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.repoId === next.repoId &&
      previous.projectId === next.projectId &&
      previous.path === next.path &&
      previous.hostId === next.hostId &&
      previous.runtimeOwnerEnvironmentId === next.runtimeOwnerEnvironmentId &&
      previous.displayName === next.displayName &&
      previous.isArchived === next.isArchived &&
      (previous.priorWorktreeIds?.length ?? 0) === (next.priorWorktreeIds?.length ?? 0) &&
      (previous.priorWorktreeIds ?? []).every((id, index) => id === next.priorWorktreeIds?.[index]))
  )
}

function sameDetectedCandidate(previous: DetectedWorktree, next: DetectedWorktree): boolean {
  if (previous === next) {
    return true
  }
  if (previous.isBare !== next.isBare) {
    return false
  }
  if (!next.isBare) {
    return true
  }
  return sameDetectedRecordCandidate(previous, next)
}

function sameDetectedRecordCandidate(previous: DetectedWorktree, next: DetectedWorktree): boolean {
  return (
    sameCandidate(previous, next) &&
    previous.ownership === next.ownership &&
    previous.visibilitySource?.kind === next.visibilitySource?.kind &&
    previous.visibilitySource?.id === next.visibilitySource?.id
  )
}

function sameListing(
  previous: Listing,
  next: Listing,
  sameRow: (previous: DetectedWorktree, next: DetectedWorktree) => boolean
): boolean {
  if (previous === next) {
    return true
  }
  if (previous.source !== next.source || previous.worktrees.length !== next.worktrees.length) {
    return false
  }
  const changes = readRecordChanges(next.worktrees, previous.worktrees)
  if (changes?.kind === 'addressed') {
    for (const key of changes.keys) {
      const before = previous.worktrees[Number(key)]
      const after = next.worktrees[Number(key)]
      if (!before || !after || !sameRow(before, after)) {
        return false
      }
    }
    return true
  }
  return next.worktrees.every((row, index) => sameRow(previous.worktrees[index], row))
}

function visibilityPolicy(
  defaults: NonNullable<AiVaultHistoryVisibilitySettings>['worktreeVisibilityDefaults']
): string {
  const preferences = normalizeWorktreeVisibilitySourcePreferences(defaults?.sourcePreferences)
  const shown = (sources: Readonly<Record<string, string | undefined>> | undefined): string[] =>
    Object.entries(sources ?? {})
      .filter(([, visibility]) => visibility === 'show')
      .map(([id]) => id)
      .sort()
  return JSON.stringify([
    defaults?.external ?? null,
    shown(preferences?.builtIn),
    shown(preferences?.custom)
  ])
}

/** Mount-local input identity, before the session-by-candidate matcher. */
export function createAiVaultHistoryCandidateSelector(
  deriveWorktrees = aiVaultHistoryWorktrees,
  sameRow = sameDetectedCandidate
) {
  const sameBucket = (previous: Listing, next: Listing): boolean =>
    sameListing(previous, next, sameRow)
  const detected = createWorktreeTabBucketProjection<Listing, Listing>({
    projectTab: (listing) => listing,
    isSameProjectedTab: sameBucket
  })
  const visible = createWorktreeTabBucketProjection<Worktree, Worktree>({
    projectTab: (row) => row,
    isSameProjectedTab: sameCandidate
  })
  let raw: Inputs['detectedWorktreesByRepo'] | undefined
  let buckets: Record<string, Listing[]> = {}
  let previousDetected: Record<string, Listing[]> | undefined
  let previousVisible: readonly Worktree[] | undefined
  let previousRepos: Inputs['repos'] | undefined
  let previousDefaults: NonNullable<AiVaultHistoryVisibilitySettings>['worktreeVisibilityDefaults']
  let previousHasSettings: boolean | undefined
  let previousPolicy: string | undefined
  let result: readonly Worktree[] = []
  return (rows: readonly Worktree[], state: Inputs): readonly Worktree[] => {
    const nextRaw = selectDetectedWorktreesByRepo(state)
    if (raw !== nextRaw) {
      const changes = raw ? readRecordChanges(nextRaw, raw) : null
      if (changes?.kind === 'addressed') {
        const replacements: [string, Listing[] | null][] = []
        for (const key of changes.keys) {
          const before = raw?.[key]
          const after = nextRaw[key]
          if (before && after && sameBucket(before, after)) {
            continue
          }
          replacements.push([key, after ? [after] : null])
        }
        if (replacements.length) {
          buckets = replaceRecordEntries(buckets, replacements)
        }
      } else {
        buckets = Object.fromEntries(
          Object.entries(nextRaw).map(([key, listing]) => [key, [listing]])
        )
      }
      raw = nextRaw
    }
    const projected = detected.project(buckets)
    const candidates = visible.project({ visible: rows }).visible
    const defaults = state.settings?.worktreeVisibilityDefaults
    const hasSettings = state.settings !== null
    const policy =
      defaults === previousDefaults && previousPolicy !== undefined
        ? previousPolicy
        : visibilityPolicy(defaults)
    previousDefaults = defaults
    if (
      projected === previousDetected &&
      candidates === previousVisible &&
      state.repos === previousRepos &&
      policy === previousPolicy &&
      hasSettings === previousHasSettings
    ) {
      return result
    }
    previousDetected = projected
    previousVisible = candidates
    previousRepos = state.repos
    previousPolicy = policy
    previousHasSettings = hasSettings
    const next = deriveWorktrees(candidates, {
      detectedWorktreesByRepo: Object.fromEntries(
        Object.entries(projected).map(([key, [listing]]) => [key, listing])
      ),
      repos: state.repos,
      settings: hasSettings ? { worktreeVisibilityDefaults: defaults } : null
    })
    if (
      next.length !== result.length ||
      next.some((row, index) => !sameCandidate(result[index], row))
    ) {
      result = next
    }
    return result
  }
}

export function useAiVaultHistoryWorktrees(visible: readonly Worktree[]): readonly Worktree[] {
  const select = useMemo(() => createAiVaultHistoryCandidateSelector(), [])
  return useAppStore((state) => select(visible, state))
}

export function useAiVaultHistoryRecordWorktrees(
  worktrees: readonly Worktree[],
  sessions: readonly AiVaultSession[]
): readonly Worktree[] {
  const select = useMemo(() => {
    const hosts = new Set(
      sessions.map((session) => normalizeExecutionHostId(session.executionHostId))
    )
    const includes = (row: DetectedWorktree): boolean => {
      const host = normalizeExecutionHostId(row.hostId)
      return hosts.size > 0 && (!host || hosts.has(null) || hosts.has(host))
    }
    return createAiVaultHistoryCandidateSelector(
      (visible, state) => aiVaultHistoryRecordWorktrees(visible, state, includes),
      (previous, next) =>
        includes(previous) === includes(next) &&
        (!includes(next) || sameDetectedRecordCandidate(previous, next))
    )
  }, [sessions])
  return useAppStore((state) => select(worktrees, state))
}
