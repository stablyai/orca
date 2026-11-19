/** Diagnostic callers opt in; operational restore and management remain independent. */
export type ResourceViewAdmission = {
  resourceManagerView?: true
  /** Background callers: skip fallback process sweeps once the asking window loses focus. */
  whileFocused?: true
}

export function isResourceViewInactive(error: unknown): boolean {
  return String(error).includes('view_not_visible')
}
