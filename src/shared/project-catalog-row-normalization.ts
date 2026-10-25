import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'

/** Normalize persisted/mixed-version Project/ProjectHostSetup rows at ingress; null/missing strings otherwise crash trim consumers
 * (3bcc5be3). Coerce only: keep row membership, optional-key presence and valid references for selector/useMemo stability.
 * Leave compared-only string unions unknown rather than inventing new state claims. */

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
