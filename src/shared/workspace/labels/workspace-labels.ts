import { z } from 'zod'
import { normalizeRepoBadgeColor } from '../../repository/appearance/repo-badge-color'

export type WorkspaceLabel = { id: string; name: string; color: string }

export const MAX_WORKSPACE_LABEL_NAME_LENGTH = 32

/** Bounds a workspace's `labelIds` wherever another process sends them. */
export const WorkspaceLabelIdsSchema = z.array(z.string().min(1).max(64)).max(50)

export type WorkspaceLabelNameError = 'empty' | 'too-long' | 'taken'

export function validateWorkspaceLabelName(
  name: string,
  existing: readonly WorkspaceLabel[]
): WorkspaceLabelNameError | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return 'empty'
  }
  if (trimmed.length > MAX_WORKSPACE_LABEL_NAME_LENGTH) {
    return 'too-long'
  }
  const key = trimmed.toLowerCase()
  return existing.some((label) => label.name.toLowerCase() === key) ? 'taken' : null
}

const LabelEntrySchema = z.object({ id: z.string().min(1), name: z.string(), color: z.string() })

/** Drops invalid entries and later duplicates (by id, or by name ignoring case). */
export function normalizeWorkspaceLabels(value: unknown): WorkspaceLabel[] {
  if (!Array.isArray(value)) {
    return []
  }
  const labels: WorkspaceLabel[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    const parsed = LabelEntrySchema.safeParse(entry)
    if (!parsed.success) {
      continue
    }
    const { id, name, color } = parsed.data
    const normalizedColor = normalizeRepoBadgeColor(color)
    if (ids.has(id) || !normalizedColor || validateWorkspaceLabelName(name, labels) !== null) {
      continue
    }
    ids.add(id)
    labels.push({ id, name: name.trim(), color: normalizedColor })
  }
  return labels
}
