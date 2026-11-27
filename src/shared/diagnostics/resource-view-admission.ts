/** Diagnostic callers opt in; operational restore and management remain independent. */
export type ResourceViewAdmission = { resourceManagerView: true }

export function isResourceViewInactive(error: unknown): boolean {
  return String(error).includes('view_not_visible')
}

/** The daemon answered, but a terminal started or exited mid-read (the resolver's 'stale inventory'). */
export function isOutdatedSessionListing(error: unknown): boolean {
  return String(error).includes('stale inventory')
}
