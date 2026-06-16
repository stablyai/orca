import { resolveRepoBadgeColor } from '../../../../shared/repo-badge-color'

// Why: ProjectGroup stores a free-form hex color (no fixed token set), so
// automation folders mirror that storage shape. We surface a small preset
// swatch row drawn from the same blue chart ramp Orca already ships in
// main.css, plus a few neutral accents, so the picker stays inside the
// documented palette instead of inventing arbitrary values.
export const AUTOMATION_FOLDER_COLOR_PRESETS: readonly string[] = [
  '#3b82f6', // blue (chart ramp mid)
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#a855f7', // purple
  '#14b8a6' // teal
]

/** Resolve the dot/swatch color for a folder. null/empty falls back to a
 *  neutral muted tone so unfiled-style folders still read as folders. */
export function resolveAutomationFolderColor(color: string | null | undefined): string | null {
  const trimmed = color?.trim()
  if (!trimmed) {
    return null
  }
  return resolveRepoBadgeColor(trimmed)
}
