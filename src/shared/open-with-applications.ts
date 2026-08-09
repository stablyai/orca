import type { OpenWithApplication } from './types'

export const OPEN_WITH_APPLICATIONS_MAX = 24

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function basenameOf(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** "/Applications/Preview.app" → "Preview"; "C:\...\sublime_text.exe" → "sublime_text". */
export function deriveOpenWithLabel(applicationPath: string): string {
  const base = basenameOf(applicationPath.trim())
  return base.replace(/\.(?:app|exe|desktop|AppImage)$/i, '') || base
}

/**
 * Turns a picked bundle/executable into a command the external-editor launcher
 * understands. macOS bundles need `open -a` because a .app is a directory, not
 * an executable; a plain binary is quoted so the launcher keeps treating it as
 * a direct executable path even when it contains spaces.
 */
export function buildOpenWithCommand(
  applicationPath: string,
  platform: NodeJS.Platform
): string | null {
  const trimmed = applicationPath.trim().replace(/[\\/]+$/, '')
  if (!trimmed) {
    return null
  }
  if (platform === 'darwin' && /\.app$/i.test(trimmed)) {
    return `open -a ${quotePosix(trimmed)}`
  }
  if (platform === 'linux' && /\.desktop$/i.test(trimmed)) {
    return `gio launch ${quotePosix(trimmed)}`
  }
  if (!/\s/.test(trimmed)) {
    return trimmed
  }
  return platform === 'win32' ? `"${trimmed}"` : quotePosix(trimmed)
}

/** Lowercase extension with the dot, or null when the entry has no usable type. */
export function getOpenWithFileTypeKey(filePath: string): string | null {
  const base = basenameOf(filePath)
  const dot = base.lastIndexOf('.')
  // Why: a leading dot is a dotfile name (.gitignore), not an extension.
  if (dot <= 0 || dot === base.length - 1) {
    return null
  }
  return base.slice(dot).toLowerCase()
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeOpenWithApplications(value: unknown): OpenWithApplication[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized: OpenWithApplication[] = []
  const seenIds = new Set<string>()
  for (const [index, row] of value.entries()) {
    if (normalized.length >= OPEN_WITH_APPLICATIONS_MAX) {
      break
    }
    if (!row || typeof row !== 'object') {
      continue
    }
    const command = normalizeToken((row as { command?: unknown }).command)
    // Why: an entry adopted from the workspace "Open in" list has a command but
    // no bundle path, and it still has to survive normalization or the rule
    // pinned to it gets dropped on the next load.
    const applicationPath = normalizeToken((row as { applicationPath?: unknown }).applicationPath)
    if (!command) {
      continue
    }
    const rawId = normalizeToken((row as { id?: unknown }).id)
    const id = rawId && !seenIds.has(rawId) ? rawId : `open-with-${index + 1}`
    if (seenIds.has(id)) {
      continue
    }
    seenIds.add(id)
    normalized.push({
      id,
      label:
        normalizeToken((row as { label?: unknown }).label) || deriveOpenWithLabel(applicationPath),
      command,
      applicationPath
    })
  }
  return normalized
}

/** Drops rules whose app was removed so a stale id can never win over the OS default. */
export function normalizeOpenWithDefaults(
  value: unknown,
  applications: readonly OpenWithApplication[]
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const knownIds = new Set(applications.map((application) => application.id))
  const normalized: Record<string, string> = {}
  for (const [rawKey, rawId] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeToken(rawKey).toLowerCase()
    const id = normalizeToken(rawId)
    if (!key.startsWith('.') || key.length < 2 || !knownIds.has(id)) {
      continue
    }
    normalized[key] = id
  }
  return normalized
}

/** Normalizes both fields together so a rule can never outlive the app it names. */
export function normalizeOpenWithSettings(
  applications: unknown,
  defaults: unknown
): { openWithApplications: OpenWithApplication[]; openWithDefaults: Record<string, string> } {
  const openWithApplications = normalizeOpenWithApplications(applications)
  return {
    openWithApplications,
    openWithDefaults: normalizeOpenWithDefaults(defaults, openWithApplications)
  }
}

/** Bundle path when the app was picked, else the command it was adopted with. */
function openWithIdentity(application: OpenWithApplication): string {
  return application.applicationPath || application.command
}

export function addOpenWithApplication(
  applications: readonly OpenWithApplication[],
  application: OpenWithApplication
): OpenWithApplication[] {
  const identity = openWithIdentity(application)
  const existingIndex = applications.findIndex((entry) => openWithIdentity(entry) === identity)
  if (existingIndex !== -1) {
    // Why: re-picking the same bundle should reuse its id so existing
    // per-type defaults keep pointing at it.
    const next = [...applications]
    next[existingIndex] = { ...application, id: applications[existingIndex].id }
    return next
  }
  return [...applications, application].slice(-OPEN_WITH_APPLICATIONS_MAX)
}

export function removeOpenWithApplication(
  applications: readonly OpenWithApplication[],
  id: string
): OpenWithApplication[] {
  return applications.filter((application) => application.id !== id)
}

export function resolveOpenWithDefaultApplication(
  filePath: string,
  applications: readonly OpenWithApplication[],
  defaults: Readonly<Record<string, string>> | undefined
): OpenWithApplication | null {
  const key = getOpenWithFileTypeKey(filePath)
  if (!key || !defaults) {
    return null
  }
  const id = defaults[key]
  return applications.find((application) => application.id === id) ?? null
}

export function setOpenWithDefault(
  defaults: Readonly<Record<string, string>> | undefined,
  fileTypeKey: string,
  applicationId: string | null
): Record<string, string> {
  const next: Record<string, string> = { ...defaults }
  if (applicationId === null) {
    delete next[fileTypeKey]
    return next
  }
  next[fileTypeKey] = applicationId
  return next
}
