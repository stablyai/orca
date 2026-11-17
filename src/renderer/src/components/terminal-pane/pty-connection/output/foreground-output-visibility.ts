import { isDocumentVisibilityProvenStale } from '../../viewport/visibility/stale-document-visibility'

export function shouldWritePtyOutputForeground(isPaneVisible: boolean): boolean {
  if (!isPaneVisible) {
    return false
  }
  if (typeof document === 'undefined') {
    return true
  }
  // Background documents need background scheduling even with visible mounted panes, or Chromium throttling can pin foreground writes.
  if (document.visibilityState === 'visible') {
    return true
  }
  // Real input can disprove stale macOS occlusion after sleep; hidden gating must then resume watched output.
  return isDocumentVisibilityProvenStale()
}
