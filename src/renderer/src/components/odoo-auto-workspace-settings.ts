import {
  DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA,
  type OdooAutoWorkspaceCriteria
} from './odoo-auto-workspace-criteria'
import { ODOO_PRIORITIES } from '../../../shared/odoo-types'
import type { OdooPriority } from '../../../shared/odoo-types'
const STORAGE_KEY = 'odoo.autoWorkspace'
/** Hard ceiling regardless of what is stored: a bad criterion must not be able
 *  to spawn an unbounded number of worktrees on one refresh. */
export const ODOO_AUTO_WORKSPACE_MAX_PER_RUN = 5

export type OdooAutoWorkspaceSettings = {
  enabled: boolean
  /** An Odoo ticket carries no repo, so the target is configured here. */
  repoId: string | null
  /** Empty means the repo's own default branch. */
  baseBranch: string
  criteria: OdooAutoWorkspaceCriteria
  maxPerRun: number
}

export const DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS: OdooAutoWorkspaceSettings = {
  enabled: false,
  repoId: null,
  baseBranch: '',
  criteria: DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA,
  maxPerRun: 3
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePriorities(value: unknown): OdooPriority[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [
    ...new Set(
      value.filter((entry): entry is OdooPriority =>
        ODOO_PRIORITIES.includes(entry as OdooPriority)
      )
    )
  ]
}

function parseStageIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter((entry): entry is number => Number.isSafeInteger(entry)))]
}

function parseCriteria(value: unknown): OdooAutoWorkspaceCriteria {
  if (!isRecord(value)) {
    return DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA
  }
  const withinDays = value.deadlineWithinDays
  return {
    assignedToMe: value.assignedToMe !== false,
    priorities: parsePriorities(value.priorities),
    stageIds: parseStageIds(value.stageIds),
    deadlineWithinDays:
      Number.isSafeInteger(withinDays) && (withinDays as number) >= 0
        ? (withinDays as number)
        : null,
    requireDescription: value.requireDescription === true
  }
}

/** Tolerant of hand-edited or older payloads: anything unreadable falls back to
 *  the disabled default rather than to a state that could create workspaces. */
export function parseOdooAutoWorkspaceSettings(raw: string | null): OdooAutoWorkspaceSettings {
  if (!raw) {
    return DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS
  }
  if (!isRecord(parsed)) {
    return DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS
  }
  // A whitespace-only id is no target at all, so normalise it away before the
  // `enabled` gate below reads it.
  const repoId = typeof parsed.repoId === 'string' ? parsed.repoId.trim() || null : null
  const maxPerRun = Number.isSafeInteger(parsed.maxPerRun) ? (parsed.maxPerRun as number) : 3
  return {
    // Why: no target repo means nothing can be created, so treat it as off
    // rather than letting a half-configured payload look armed.
    enabled: parsed.enabled === true && repoId !== null,
    repoId,
    baseBranch: typeof parsed.baseBranch === 'string' ? parsed.baseBranch.trim() : '',
    criteria: parseCriteria(parsed.criteria),
    maxPerRun: Math.min(Math.max(maxPerRun, 0), ODOO_AUTO_WORKSPACE_MAX_PER_RUN)
  }
}

export function readOdooAutoWorkspaceSettings(): OdooAutoWorkspaceSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS
  }
  return parseOdooAutoWorkspaceSettings(window.localStorage.getItem(STORAGE_KEY))
}

export function writeOdooAutoWorkspaceSettings(settings: OdooAutoWorkspaceSettings): void {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
