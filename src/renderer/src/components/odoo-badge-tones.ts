import type { OdooStage } from '../../../shared/odoo-types'
// Odoo kanban color indexes (0-11). Index 0 is "no color" → neutral. The rest
// mirror Odoo's palette order (red, orange, yellow, cyan, purple, …) as soft
// badge tints. Data-viz colors like these sit outside the token set on purpose,
// matching the existing PRIORITY_TONES precedent in task-page-odoo-panel.tsx.
const ODOO_COLOR_BADGES: readonly string[] = [
  'border-border/60 bg-muted/50 text-muted-foreground',
  'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300',
  'border-rose-400/30 bg-rose-400/10 text-rose-700 dark:text-rose-300',
  'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300',
  'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
  'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
] as const

/** Badge classes for an Odoo color index (tags carry these directly). */
export function odooColorBadgeClass(color: number | undefined): string {
  // Integer check, not just a range check: NaN and fractional indexes would slip
  // through and make the array lookup return undefined.
  if (
    color === undefined ||
    !Number.isInteger(color) ||
    color < 0 ||
    color >= ODOO_COLOR_BADGES.length
  ) {
    return ODOO_COLOR_BADGES[0]
  }
  return ODOO_COLOR_BADGES[color]
}

/**
 * Badge classes for a stage. Stages often leave `color` unset (0), so a stable
 * hue is derived from the id to keep each kanban column visually distinct — the
 * "code couleur" the general view was missing.
 */
export function odooStageBadgeClass(stage: Pick<OdooStage, 'id' | 'color'>): string {
  if (typeof stage.color === 'number' && stage.color > 0) {
    return odooColorBadgeClass(stage.color)
  }
  return ODOO_COLOR_BADGES[(stage.id % (ODOO_COLOR_BADGES.length - 1)) + 1]
}

/** Deadline badge tone: overdue → red, within 3 days → amber, else neutral. */
export function odooDeadlineBadgeClass(deadlineIso: string): string {
  const due = new Date(deadlineIso).getTime()
  if (Number.isNaN(due)) {
    return ODOO_COLOR_BADGES[0]
  }
  const remaining = due - Date.now()
  if (remaining < 0) {
    return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
  }
  if (remaining < 3 * 86_400_000) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  }
  return ODOO_COLOR_BADGES[0]
}

/** Customer chip accent — a single consistent tone so the partner stands out. */
export const ODOO_CUSTOMER_BADGE_CLASS =
  'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
