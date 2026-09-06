import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'

/**
 * Repairs untrusted `Project` / `ProjectHostSetup` rows so their declared field types are true.
 *
 * These rows reach typed code from persisted JSON and from remote Orca hosts running a different
 * version, where a field the type promises is a `string` can arrive `null`, missing, or another
 * type entirely — while consumers call `.trim()` on it unconditionally (crash 3bcc5be3). Call
 * these at every boundary such a row enters the app, so nothing downstream has to re-guard.
 *
 * Coercion only. A normalizer never drops a row, never adds or removes an optional key, and
 * returns its input reference untouched when it already conforms — callers keep row and array
 * identity, which selectors and `useMemo` deps depend on.
 *
 * The string-literal unions (`setupState`, `setupMethod`) are deliberately left alone: they are
 * only ever compared, so an unknown value degrades instead of crashing, and inventing a fallback
 * would silently change what a corrupt row claims about itself.
 */

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why 0 and not now(): the catalog merge already reads 0 as "timestamp unknown", not as the epoch.
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return isString(value) ? value : fallback
}

function timestampValue(value: unknown): number {
  return isTimestamp(value) ? value : 0
}

export function normalizeProjectHostSetupRow(setup: ProjectHostSetup): ProjectHostSetup {
  const row: Record<string, unknown> = isRecord(setup) ? setup : {}
  const needsRepair =
    !isString(row.id) ||
    !isString(row.projectId) ||
    !isString(row.hostId) ||
    !isString(row.repoId) ||
    !isString(row.path) ||
    !isString(row.displayName) ||
    !isTimestamp(row.createdAt) ||
    !isTimestamp(row.updatedAt)
  if (!needsRepair) {
    return setup
  }
  return {
    ...row,
    id: stringValue(row.id),
    projectId: stringValue(row.projectId),
    hostId: stringValue(row.hostId, LOCAL_EXECUTION_HOST_ID) as ProjectHostSetup['hostId'],
    repoId: stringValue(row.repoId),
    path: stringValue(row.path),
    displayName: stringValue(row.displayName),
    setupState: (row.setupState === undefined
      ? 'error'
      : row.setupState) as ProjectHostSetup['setupState'],
    setupMethod: (row.setupMethod === undefined
      ? 'legacy-repo'
      : row.setupMethod) as ProjectHostSetup['setupMethod'],
    createdAt: timestampValue(row.createdAt),
    updatedAt: timestampValue(row.updatedAt)
  }
}

export function normalizeProjectRow(project: Project): Project {
  const row: Record<string, unknown> = isRecord(project) ? project : {}
  const sourceRepoIdsConform = Array.isArray(row.sourceRepoIds) && row.sourceRepoIds.every(isString)
  const needsRepair =
    !isString(row.id) ||
    !isString(row.displayName) ||
    !isString(row.badgeColor) ||
    !sourceRepoIdsConform ||
    !isTimestamp(row.createdAt) ||
    !isTimestamp(row.updatedAt)
  if (!needsRepair) {
    return project
  }
  return {
    ...row,
    id: stringValue(row.id),
    displayName: stringValue(row.displayName),
    badgeColor: stringValue(row.badgeColor),
    sourceRepoIds: Array.isArray(row.sourceRepoIds)
      ? row.sourceRepoIds.filter((repoId): repoId is string => isString(repoId))
      : [],
    createdAt: timestampValue(row.createdAt),
    updatedAt: timestampValue(row.updatedAt)
  }
}

function normalizeRows<T>(rows: T[], normalize: (row: T) => T): T[] {
  if (!Array.isArray(rows)) {
    return []
  }
  let repaired: T[] | null = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const normalized = normalize(row)
    if (normalized !== row && !repaired) {
      repaired = rows.slice(0, index)
    }
    repaired?.push(normalized)
  }
  return repaired ?? rows
}

export function normalizeProjectHostSetupRows(setups: ProjectHostSetup[]): ProjectHostSetup[] {
  return normalizeRows(setups, normalizeProjectHostSetupRow)
}

export function normalizeProjectRows(projects: Project[]): Project[] {
  return normalizeRows(projects, normalizeProjectRow)
}
