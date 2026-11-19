/** Diagnostic callers opt in; operational restore and management remain independent. */
export type ResourceViewAdmission = {
  resourceManagerView?: true
  /** Background callers: no process sweep starts once the asking window loses focus. */
  whileFocused?: true
  /** Background callers: wall-clock ms after which the user counts as away and no sweep starts. */
  activeUntil?: number
}

export function isResourceViewInactive(error: unknown): boolean {
  return String(error).includes('view_not_visible')
}
