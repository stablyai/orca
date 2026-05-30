import type { WorkspaceGroup, WorkspaceGroupColor, WorkspaceGroupId, WorktreeMeta } from './types'

export const WORKSPACE_GROUP_COLOR_IDS = [
  'neutral',
  'blue',
  'sky',
  'violet',
  'amber',
  'emerald',
  'rose',
  'zinc'
] as const satisfies readonly WorkspaceGroupColor[]

export const DEFAULT_WORKSPACE_GROUP_COLOR: WorkspaceGroupColor = 'neutral'
export const FALLBACK_GROUP_NAME = 'Untitled group'
const MAX_GROUP_NAME_LENGTH = 64

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') {
    return FALLBACK_GROUP_NAME
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) {
    return FALLBACK_GROUP_NAME
  }
  return trimmed.slice(0, MAX_GROUP_NAME_LENGTH)
}

function sanitizeColor(value: unknown): WorkspaceGroupColor {
  return (WORKSPACE_GROUP_COLOR_IDS as readonly string[]).includes(value as string)
    ? (value as WorkspaceGroupColor)
    : DEFAULT_WORKSPACE_GROUP_COLOR
}

function generateGroupId(): WorkspaceGroupId {
  const rand = Math.random().toString(36).slice(2, 10)
  return `wg_${Date.now().toString(36)}_${rand}`
}

export function createWorkspaceGroup(args: {
  name: string
  color: WorkspaceGroupColor
  sortOrder: number
}): WorkspaceGroup {
  return {
    id: generateGroupId(),
    name: sanitizeName(args.name),
    color: sanitizeColor(args.color),
    collapsed: false,
    sortOrder: Number.isFinite(args.sortOrder) ? args.sortOrder : 0,
    createdAt: Date.now()
  }
}

export function sanitizeWorkspaceGroup(raw: WorkspaceGroup): WorkspaceGroup {
  return {
    id: raw.id,
    name: sanitizeName(raw.name),
    color: sanitizeColor(raw.color),
    collapsed: Boolean(raw.collapsed),
    sortOrder: Number.isFinite(raw.sortOrder) ? raw.sortOrder : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  }
}

export function normalizeWorkspaceGroups(
  raw: WorkspaceGroup[] | undefined | null
): WorkspaceGroup[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const seen = new Set<string>()
  const result: WorkspaceGroup[] = []
  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      continue
    }
    if (seen.has(entry.id)) {
      continue
    }
    seen.add(entry.id)
    result.push(sanitizeWorkspaceGroup(entry))
  }
  result.sort((a, b) => a.sortOrder - b.sortOrder)
  return result
}

export function clearWorkspaceGroupFromMeta(
  meta: Record<string, WorktreeMeta>,
  groupId: WorkspaceGroupId
): Record<string, WorktreeMeta> {
  const next: Record<string, WorktreeMeta> = {}
  for (const [id, m] of Object.entries(meta)) {
    next[id] = m && m.workspaceGroupId === groupId ? { ...m, workspaceGroupId: null } : m
  }
  return next
}

export function pickAutoCycledColor(
  existingColorsMostRecentLast: readonly WorkspaceGroupColor[]
): WorkspaceGroupColor {
  if (existingColorsMostRecentLast.length === 0) {
    return WORKSPACE_GROUP_COLOR_IDS[0]
  }
  const last = existingColorsMostRecentLast.at(-1)!
  const idx = WORKSPACE_GROUP_COLOR_IDS.indexOf(last)
  const next = WORKSPACE_GROUP_COLOR_IDS[(idx + 1) % WORKSPACE_GROUP_COLOR_IDS.length]!
  return next
}
