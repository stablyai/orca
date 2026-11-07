// Import-free so hot paths (the output scheduler) can read the latch without the recovery module's breadcrumb graph.
let visibilityProvenStale = false

export function isDocumentVisibilityProvenStale(): boolean {
  return visibilityProvenStale
}

export function setDocumentVisibilityProvenStale(stale: boolean): void {
  visibilityProvenStale = stale
}
