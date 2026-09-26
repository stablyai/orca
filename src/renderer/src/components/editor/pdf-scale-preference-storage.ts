import type { PdfScalePreference } from './pdf-scale-preference'

export const PDF_SCALE_PREFERENCES_STORAGE_KEY = 'orca.pdf.scale-preferences.v1'

const MAX_STORED_PREFERENCES = 100

export function buildPdfScalePreferenceKey(input: {
  worktreeId: string
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string | null
  filePath: string
}): string {
  return JSON.stringify([
    input.worktreeId,
    input.runtimeEnvironmentId?.trim() || 'local',
    input.externalSshTargetId?.trim() || null,
    input.filePath
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPdfScalePreference(value: unknown): value is PdfScalePreference {
  return value === 'page-width' || (typeof value === 'number' && Number.isFinite(value))
}

function readStoredPreferences(storage: Storage): Record<string, unknown> {
  try {
    const raw = storage.getItem(PDF_SCALE_PREFERENCES_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage === undefined ? null : globalThis.localStorage
  } catch {
    return null
  }
}

/** Read the last zoom choice for a PDF, if one was persisted. */
export function readPdfScalePreference(preferenceKey: string): PdfScalePreference | null {
  const storage = getStorage()
  if (!storage) {
    return null
  }
  const preference = readStoredPreferences(storage)[preferenceKey]
  return isPdfScalePreference(preference) ? preference : null
}

/** Persist a PDF zoom choice across viewer remounts and app restarts. */
export function writePdfScalePreference(
  preferenceKey: string,
  preference: PdfScalePreference
): void {
  const storage = getStorage()
  if (!storage) {
    return
  }

  const stored = readStoredPreferences(storage)
  // Reinsert to keep recently used files at the end of the bounded map.
  delete stored[preferenceKey]
  stored[preferenceKey] = preference
  const keys = Object.keys(stored)
  while (keys.length > MAX_STORED_PREFERENCES) {
    const oldestKey = keys.shift()
    if (oldestKey !== undefined) {
      delete stored[oldestKey]
    }
  }

  try {
    storage.setItem(PDF_SCALE_PREFERENCES_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // The viewer remains usable when browser storage is unavailable or full.
  }
}
