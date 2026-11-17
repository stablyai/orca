/** Diagnostic callers opt in; operational restore and management remain independent. */
export type ResourceViewAdmission = { resourceManagerView: true }

export function isResourceViewInactive(error: unknown): boolean {
  return String(error).includes('view_not_visible')
}
