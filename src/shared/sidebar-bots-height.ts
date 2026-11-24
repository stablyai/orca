/** Header plus about one bot row and the gap above the divider, so a dragged-up Bots section stays usable. */
export const SIDEBAR_BOTS_MIN_HEIGHT = 88
/** About three project rows below the Projects header stay visible. */
export const SIDEBAR_PROJECTS_MIN_LIST_HEIGHT = 120
const SIDEBAR_BOTS_MAX_STORED_HEIGHT = 4000

/** A saved Bots section cap in px, or null for the default content-sized 40% cap. */
export function normalizeSidebarBotsHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.min(
    SIDEBAR_BOTS_MAX_STORED_HEIGHT,
    Math.max(SIDEBAR_BOTS_MIN_HEIGHT, Math.round(value))
  )
}

/** Tallest Bots section now: its height plus what the Projects list can give up above its minimum. */
export function computeSidebarBotsMaxHeight(
  botsHeight: number,
  projectsListHeight: number
): number {
  if (!Number.isFinite(botsHeight) || !Number.isFinite(projectsListHeight)) {
    return SIDEBAR_BOTS_MAX_STORED_HEIGHT
  }
  return Math.max(
    SIDEBAR_BOTS_MIN_HEIGHT,
    botsHeight + projectsListHeight - SIDEBAR_PROJECTS_MIN_LIST_HEIGHT
  )
}
