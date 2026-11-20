import type { BrowserSessionProfileSource } from '../../../shared/browser/workspaces/browser-workspace-types'

// Why localStorage: the Tauri renderer has no main process holding the import
// map like Electron's clientRouteCookieImportSources, so this desktop's
// client-route badges persist here, keyed by environment then profile.
const STORAGE_KEY = 'orca.tauri.browser.clientRouteImportSources.v1'

// Why 128: mirrors Electron badge cap and the Rust host store; oldest imports go first.
const MAX_CLIENT_ROUTE_SOURCE_ENTRIES = 128

type ClientRouteImportSourceMap = Record<string, Record<string, BrowserSessionProfileSource>>

const CLIENT_ROUTE_SOURCE_FAMILIES: readonly BrowserSessionProfileSource['browserFamily'][] = [
  'chrome',
  'chromium',
  'arc',
  'edge',
  'firefox',
  'safari',
  'comet',
  'helium',
  'manual'
]

export function asClientRouteSourceFamily(
  value: string
): BrowserSessionProfileSource['browserFamily'] | null {
  return CLIENT_ROUTE_SOURCE_FAMILIES.find((family) => family === value) ?? null
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseSource(value: unknown): BrowserSessionProfileSource | null {
  if (!isStringRecord(value)) {
    return null
  }
  const family =
    typeof value.browserFamily === 'string' ? asClientRouteSourceFamily(value.browserFamily) : null
  if (!family) {
    return null
  }
  return {
    browserFamily: family,
    ...(typeof value.profileName === 'string' ? { profileName: value.profileName } : {}),
    importedAt: typeof value.importedAt === 'number' ? value.importedAt : Date.now()
  }
}

function readStored(): ClientRouteImportSourceMap {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isStringRecord(parsed)) {
      return {}
    }
    const result: ClientRouteImportSourceMap = {}
    for (const [environmentId, byProfile] of Object.entries(parsed)) {
      if (!isStringRecord(byProfile)) {
        continue
      }
      const profiles: Record<string, BrowserSessionProfileSource> = {}
      for (const [profileId, source] of Object.entries(byProfile)) {
        const parsedSource = parseSource(source)
        if (parsedSource) {
          profiles[profileId] = parsedSource
        }
      }
      result[environmentId] = profiles
    }
    return result
  } catch {
    return {}
  }
}

function writeStored(value: ClientRouteImportSourceMap): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Best-effort: a full or blocked store must not break cookie import.
  }
}

export function readTauriClientRouteImportSources(
  environmentId: string
): Record<string, BrowserSessionProfileSource> {
  return readStored()[environmentId] ?? {}
}

export function sanitizeClientRouteSources(
  value: unknown
): Record<string, BrowserSessionProfileSource> {
  if (!isStringRecord(value)) {
    return {}
  }
  const result: Record<string, BrowserSessionProfileSource> = {}
  for (const [profileId, source] of Object.entries(value)) {
    const parsed = parseSource(source)
    if (parsed) {
      result[profileId] = parsed
    }
  }
  return result
}

export function recordTauriClientRouteImportSource(
  environmentId: string,
  profileId: string,
  source: BrowserSessionProfileSource
): void {
  const stored = readStored()
  const next: ClientRouteImportSourceMap = {
    ...stored,
    [environmentId]: {
      ...stored[environmentId],
      [profileId]: source
    }
  }
  let total = 0
  for (const byProfile of Object.values(next)) {
    total += Object.keys(byProfile).length
  }
  if (total > MAX_CLIENT_ROUTE_SOURCE_ENTRIES) {
    const byAge: { environmentId: string; profileId: string; importedAt: number }[] = []
    for (const [envId, byProfile] of Object.entries(next)) {
      for (const [profId, entry] of Object.entries(byProfile)) {
        byAge.push({ environmentId: envId, profileId: profId, importedAt: entry.importedAt })
      }
    }
    byAge.sort((a, b) => a.importedAt - b.importedAt)
    for (const victim of byAge.slice(0, total - MAX_CLIENT_ROUTE_SOURCE_ENTRIES)) {
      delete next[victim.environmentId]?.[victim.profileId]
      if (Object.keys(next[victim.environmentId] ?? {}).length === 0) {
        delete next[victim.environmentId]
      }
    }
  }
  writeStored(next)
}

export function resetTauriClientRouteImportSourcesForTest(): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Best-effort test cleanup.
  }
}
