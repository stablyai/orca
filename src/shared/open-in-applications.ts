import type { OpenInApplication } from './ui-chrome-types'

export const OPEN_IN_APPLICATIONS_MAX = 8
export const BUILT_IN_EDITOR_COMMANDS = {
  vscode: 'code',
  cursor: 'cursor',
  zed: 'zed',
  // Devin Desktop (formerly Windsurf) installs this launcher; `devin` is the Devin CLI agent.
  'devin-desktop': 'devin-desktop',
  // Antigravity IDE's bundled launcher; `agy` is the Antigravity CLI agent.
  'antigravity-ide': 'antigravity-ide'
} as const
export type BuiltInEditorId = keyof typeof BUILT_IN_EDITOR_COMMANDS

export const DEFAULT_OPEN_IN_APPLICATIONS: OpenInApplication[] = [
  { id: 'vscode', label: 'VS Code', command: BUILT_IN_EDITOR_COMMANDS.vscode }
]

type NormalizeOpenInApplicationsOptions = {
  createId?: () => string
  seedDefaults?: boolean
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function makeFallbackId(index: number): string {
  return `open-in-${index + 1}`
}

export function normalizeOpenInApplicationId(value: unknown): string | null {
  return normalizeToken(value) || null
}

export function normalizeOpenInApplications(
  value: unknown,
  options: NormalizeOpenInApplicationsOptions = {}
): OpenInApplication[] {
  if (!Array.isArray(value)) {
    return options.seedDefaults ? [...DEFAULT_OPEN_IN_APPLICATIONS] : []
  }

  const normalized: OpenInApplication[] = []
  const seenIds = new Set<string>()

  for (const [index, row] of value.entries()) {
    if (normalized.length >= OPEN_IN_APPLICATIONS_MAX) {
      break
    }
    if (!row || typeof row !== 'object') {
      continue
    }

    const label = normalizeToken((row as { label?: unknown }).label)
    const command = normalizeToken((row as { command?: unknown }).command)
    if (!label || !command) {
      continue
    }

    let id = normalizeToken((row as { id?: unknown }).id)
    if (!id) {
      id = normalizeToken(options.createId?.())
      if (!id) {
        id = makeFallbackId(index)
      }
    }

    if (seenIds.has(id)) {
      continue
    }
    seenIds.add(id)
    normalized.push({ id, label, command })
  }

  return normalized
}
