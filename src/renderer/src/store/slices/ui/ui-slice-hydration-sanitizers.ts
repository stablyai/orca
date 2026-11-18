import { isProjectGroupHookTrustKey } from '../../../../../shared/workspace-setup/hooks/workspace-hook-owner'
import { normalizeExplorerDisplayRootByWorktree } from '../../../../../shared/file-listing/file-explorer-display-root'
import type { AppState } from '../../types'
import type { PersistedTrustedOrcaHooks } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import type {
  ActivityBarPosition,
  TaskViewPresetId,
  TopLevelView,
  VisibleWorkspaceHostIds
} from '../../../../../shared/ui-chrome/ui-chrome-types'

import {
  type WorkspaceCleanupDismissal,
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { isTopLevelView } from '../../../../../shared/ui-chrome/top-level-view'
import { AGENT_STATUS_HYDRATE_MAX_AGE_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { resolveVisibleWorkspaceHostIds } from '../../../../../shared/workspace-view/workspace-host-visibility'
import { persistedUIValuesEqual } from '../../../../../shared/collections/persisted-ui-equality'
import '../../../../../shared/orca-profiles/constants'
import type { UISlice } from './ui-slice-contract'

const MIN_SIDEBAR_WIDTH = 220

export function preserveStringArrayIdentity<T extends string>(
  current: readonly T[] | null,
  next: T[] | null
): T[] | null {
  if (!current || !next) {
    return next
  }
  return current.length === next.length && current.every((value, index) => value === next[index])
    ? (current as T[])
    : next
}

export function isPlainPersistedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isSafePersistedRecordKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

export function sanitizePersistedRepoIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((repoId): repoId is string => typeof repoId === 'string')
}

export function sanitizeTrustedOrcaHooks(trust: unknown): PersistedTrustedOrcaHooks {
  if (!isPlainPersistedRecord(trust)) {
    return {}
  }
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (!isSafePersistedRecordKey(repoId) || !isPlainPersistedRecord(entry)) {
      continue
    }
    next[repoId] = entry as PersistedTrustedOrcaHooks[string]
  }
  return next
}

export function hydrateTrustedOrcaHooks(
  trust: unknown,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const sanitized = sanitizeTrustedOrcaHooks(trust)
  if (validRepoIds.size === 0) {
    return sanitized
  }
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(sanitized)) {
    if (validRepoIds.has(repoId) || isProjectGroupHookTrustKey(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

export function sanitizeShowDotfilesByWorktree(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [worktreeId, showDotfiles] of Object.entries(value as Record<string, unknown>)) {
    if (!worktreeId || !isSafePersistedRecordKey(worktreeId) || typeof showDotfiles !== 'boolean') {
      continue
    }
    out[worktreeId] = showDotfiles
  }
  return out
}

export function sanitizePersistedSidebarWidth(
  width: unknown,
  fallback: number,
  maxWidth: number
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
}

// Any other value would hide the activity bar entirely, since the layout renders only Top or Side.
export function sanitizeActivityBarPosition(position: unknown): ActivityBarPosition {
  return position === 'side' ? 'side' : 'top'
}

export function sanitizePaneKeyTimestampRecord(
  value: unknown,
  maxAgeMs: number = AGENT_STATUS_HYDRATE_MAX_AGE_MS
): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const cutoff = Date.now() - maxAgeMs
  const out: Record<string, number> = {}
  for (const [key, ackAt] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafePersistedRecordKey(key)) {
      continue
    }
    if (typeof ackAt !== 'number' || !Number.isFinite(ackAt) || ackAt <= 0 || ackAt < cutoff) {
      continue
    }
    out[key] = ackAt
  }
  return out
}

export const sanitizeAcknowledgedAgentsByPaneKey = sanitizePaneKeyTimestampRecord

// Structured chat rows hydrate at any age, so cutoffs are never age-pruned; the newest clears bound growth instead.
const ACTIVITY_CLEARED_AT_MAX_ENTRIES = 500

export function sanitizeActivityClearedAtByPaneKey(value: unknown): Record<string, number> {
  const valid = sanitizePaneKeyTimestampRecord(value, Number.POSITIVE_INFINITY)
  const entries = Object.entries(valid)
  if (entries.length <= ACTIVITY_CLEARED_AT_MAX_ENTRIES) {
    return valid
  }
  return Object.fromEntries(
    entries
      .toSorted(([, left], [, right]) => right - left)
      .slice(0, ACTIVITY_CLEARED_AT_MAX_ENTRIES)
  )
}

export function sanitizeWorkspaceCleanupDismissals(
  value: unknown
): Record<string, WorkspaceCleanupDismissal> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, WorkspaceCleanupDismissal> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      !isSafePersistedRecordKey(key) ||
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    ) {
      continue
    }
    const input = raw as Record<string, unknown>
    if (
      typeof input.worktreeId !== 'string' ||
      typeof input.dismissedAt !== 'number' ||
      !Number.isFinite(input.dismissedAt) ||
      typeof input.fingerprint !== 'string' ||
      input.classifierVersion !== WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    ) {
      continue
    }
    out[key] = {
      worktreeId: input.worktreeId,
      dismissedAt: input.dismissedAt,
      fingerprint: input.fingerprint,
      classifierVersion: input.classifierVersion
    }
  }
  return out
}

export function sanitizeHydratedActiveView(value: PersistedUIState['activeView']): TopLevelView {
  // Why: older data (pre-activeView) or a view a different build doesn't have falls back to terminal rather than rendering nothing.
  if (!isTopLevelView(value)) {
    return 'terminal'
  }
  return value
}

export function hydratedUIPartialMatchesState(
  state: AppState,
  hydrated: Partial<UISlice>
): boolean {
  return Object.entries(hydrated).every(([key, value]) =>
    persistedUIValuesEqual(state[key as keyof AppState], value)
  )
}

export function normalizeHydratedVisibleWorkspaceHostIds(
  ui: PersistedUIState
): VisibleWorkspaceHostIds {
  return resolveVisibleWorkspaceHostIds(ui.visibleWorkspaceHostIds, ui.workspaceHostScope)
}

export function clampPetSize(
  size: number,
  defaults: { min: number; max: number; fallback: number }
): number {
  if (!Number.isFinite(size)) {
    return defaults.fallback
  }
  return Math.max(defaults.min, Math.min(defaults.max, Math.round(size)))
}

export function presetToQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
    case 'all':
    case 'issues':
      return 'is:issue is:open'
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case null:
      return 'is:issue is:open'
  }
}

export function hydrateUnexpectedSignoutDismissal(
  state: Pick<UISlice, 'unexpectedSignoutDismissedVersions'>,
  version: string | null | undefined
): Pick<UISlice, 'dismissedUnexpectedSignoutVersion' | 'unexpectedSignoutDismissedVersions'> {
  const observed = state.unexpectedSignoutDismissedVersions
  return {
    dismissedUnexpectedSignoutVersion: version ?? null,
    // A later sync must never undo any dismissal observed in this session.
    unexpectedSignoutDismissedVersions:
      typeof version === 'string' && !observed.includes(version) ? [...observed, version] : observed
  }
}

/** Normalizes persisted per-worktree explorer and notification records before hydration, including malformed or absent legacy values. */
export function sanitizePerWorktreePreferences(
  ui: PersistedUIState
): Pick<
  AppState,
  'explorerDisplayRootByWorktree' | 'showDotfilesByWorktree' | 'notificationsMutedByWorktree'
> {
  return {
    explorerDisplayRootByWorktree: normalizeExplorerDisplayRootByWorktree(
      ui.explorerDisplayRootByWorktree
    ),
    showDotfilesByWorktree: sanitizeShowDotfilesByWorktree(ui.showDotfilesByWorktree),
    // Same persisted shape as the dotfile map: a per-worktree boolean opt-in record.
    notificationsMutedByWorktree: sanitizeShowDotfilesByWorktree(ui.notificationsMutedByWorktree)
  }
}
