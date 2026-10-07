import type { PdfScalePreference } from './pdf-scale-preference'
import { readFileViewPreference, writeFileViewPreference } from './file-view-preference-storage'
export { buildFileViewPreferenceKey as buildPdfScalePreferenceKey } from './file-view-preference-storage'

export const PDF_SCALE_PREFERENCES_STORAGE_KEY = 'orca.pdf.scale-preferences.v1'

export function readPdfScalePreference(preferenceKey: string): PdfScalePreference | null {
  const value = readFileViewPreference(PDF_SCALE_PREFERENCES_STORAGE_KEY, preferenceKey)
  return value === 'page-width' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : null
}

export function writePdfScalePreference(
  preferenceKey: string,
  preference: PdfScalePreference
): void {
  writeFileViewPreference(PDF_SCALE_PREFERENCES_STORAGE_KEY, preferenceKey, preference)
}
