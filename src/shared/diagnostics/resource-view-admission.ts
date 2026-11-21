/** Diagnostic callers opt in; operational restore and management remain independent. */
export type ResourceViewAdmission = {
  resourceManagerView: true
  /** Lets the view retire this request, so main stops repeating work nobody will publish. */
  requestId?: string
}

export function isResourceViewInactive(error: unknown): boolean {
  return String(error).includes('view_not_visible')
}
