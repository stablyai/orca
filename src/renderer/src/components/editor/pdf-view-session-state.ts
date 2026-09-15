import type { PdfScalePreference } from './pdf-scale-preference'

export type PdfViewSessionState = {
  scalePreference: PdfScalePreference
}

// Why: tab hide/show unmounts PdfViewer; keep its zoom preference for the open
// path in this app session. PDF scroll is stored separately in pdf.js user space
// by the shared position cache, so it remains correct across zoom and pane width.
const sessionByPath = new Map<string, PdfViewSessionState>()

export function getPdfViewSession(filePath: string): PdfViewSessionState | undefined {
  if (!filePath) {
    return undefined
  }
  return sessionByPath.get(filePath)
}

export function setPdfViewSession(
  filePath: string,
  next: Partial<PdfViewSessionState>
): PdfViewSessionState | undefined {
  if (!filePath) {
    return undefined
  }
  const previous = sessionByPath.get(filePath)
  const merged: PdfViewSessionState = {
    scalePreference: next.scalePreference ?? previous?.scalePreference ?? 'page-width'
  }
  sessionByPath.set(filePath, merged)
  return merged
}

/** @internal tests only */
export function _resetPdfViewSessionStateForTest(): void {
  sessionByPath.clear()
}
