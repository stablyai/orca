import {
  aiVaultHistoryAgents,
  isAiVaultAgent,
  type AiVaultAgent
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

/**
 * Names the user gave terminal tabs, remembered per agent session so Session History keeps them
 * after the tab closes and a resume can name its new tab. Kept on this client only.
 */
export const TERMINAL_SESSION_NAMES_STORAGE_KEY = 'orca.aiVault.terminalSessionNames.v1'
export const TERMINAL_SESSION_NAMES_MAX_ENTRIES = 500
const TITLE_MAX_LENGTH = 200

export type TerminalSessionNameEntry = {
  title: string
  agent: AiVaultAgent
  /** The tab whose name this is; only that tab's clear forgets it. */
  tabId: string
  savedAt: number
}

type Entries = Map<string, TerminalSessionNameEntry>

let entries: Entries | null = null
const listeners = new Set<() => void>()

export function terminalSessionNameKey(executionHostId: string, sessionId: string): string {
  return `${executionHostId}\0${sessionId}`
}

// eslint-disable-next-line no-control-regex -- strip control characters from stored names
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g

/** One spelling for stored and compared names, so an unchanged name never rewrites storage. */
export function normalizeTerminalSessionName(title: string | null | undefined): string {
  return (title ?? '').replace(CONTROL_CHARACTERS, ' ').trim().slice(0, TITLE_MAX_LENGTH).trim()
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validEntry(key: string, record: unknown): TerminalSessionNameEntry | null {
  const separator = key.indexOf('\0')
  if (separator <= 0 || separator === key.length - 1 || !isRecord(record)) {
    return null
  }
  const title = typeof record.title === 'string' ? normalizeTerminalSessionName(record.title) : ''
  if (
    !title ||
    !isAiVaultAgent(record.agent) ||
    typeof record.tabId !== 'string' ||
    !record.tabId ||
    typeof record.savedAt !== 'number' ||
    !Number.isFinite(record.savedAt)
  ) {
    return null
  }
  return {
    title,
    agent: record.agent,
    tabId: record.tabId,
    savedAt: record.savedAt
  }
}

/** Valid entries survive a partly corrupt or foreign blob; anything unreadable is an empty map. */
function readStored(): Entries {
  const next: Entries = new Map()
  let raw: string | null = null
  try {
    raw = storage()?.getItem(TERMINAL_SESSION_NAMES_STORAGE_KEY) ?? null
  } catch {
    return next
  }
  if (!raw) {
    return next
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return next
  }
  if (!isRecord(parsed)) {
    return next
  }
  for (const [key, value] of Object.entries(parsed)) {
    const entry = validEntry(key, value)
    if (entry) {
      next.set(key, entry)
    }
  }
  return next
}

function loaded(): Entries {
  entries ??= readStored()
  return entries
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Re-read before writing so another window's saves and forgets are kept; apply only this change. */
function commit(change: (current: Entries) => boolean): void {
  const current = readStored()
  if (!change(current)) {
    entries = current
    return
  }
  if (current.size > TERMINAL_SESSION_NAMES_MAX_ENTRIES) {
    const oldestFirst = [...current.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)
    for (const [key] of oldestFirst.slice(0, current.size - TERMINAL_SESSION_NAMES_MAX_ENTRIES)) {
      current.delete(key)
    }
  }
  entries = current
  try {
    storage()?.setItem(
      TERMINAL_SESSION_NAMES_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(current))
    )
  } catch {
    // Quota or a disabled store: the change lives in memory only until the next write re-reads.
  }
  notify()
}

export function getTerminalSessionNameEntry(
  executionHostId: string,
  sessionId: string
): TerminalSessionNameEntry | undefined {
  return loaded().get(terminalSessionNameKey(executionHostId, sessionId))
}

/** The saved name for a Session History row; agent-checked since OpenCode rows list as `opencode2`. */
export function getSavedTerminalSessionName(
  executionHostId: string,
  agent: AiVaultAgent,
  sessionId: string
): string | null {
  const entry = getTerminalSessionNameEntry(executionHostId, sessionId)
  return entry && aiVaultHistoryAgents(entry.agent).includes(agent) ? entry.title : null
}

export function saveTerminalSessionName(args: {
  executionHostId: string
  sessionId: string
  agent: AiVaultAgent
  tabId: string
  title: string
}): void {
  const title = normalizeTerminalSessionName(args.title)
  if (!title || !args.executionHostId || !args.sessionId || !args.tabId) {
    return
  }
  const key = terminalSessionNameKey(args.executionHostId, args.sessionId)
  const existing = loaded().get(key)
  if (existing?.title === title && existing.tabId === args.tabId && existing.agent === args.agent) {
    return
  }
  commit((current) => {
    const stored = current.get(key)
    if (stored?.title === title && stored.tabId === args.tabId && stored.agent === args.agent) {
      return false
    }
    current.set(key, {
      title,
      agent: args.agent,
      tabId: args.tabId,
      savedAt: Date.now()
    })
    return true
  })
}

/** Forget the given keys; no write when none is stored. */
export function forgetTerminalSessionNames(keys: Iterable<string>): void {
  const wanted = [...keys].filter((key) => loaded().has(key))
  if (wanted.length === 0) {
    return
  }
  commit((current) => {
    let changed = false
    for (const key of wanted) {
      changed = current.delete(key) || changed
    }
    return changed
  })
}

/** Keys of every entry this tab owns. */
export function terminalSessionNameKeysOwnedBy(tabId: string): string[] {
  const keys: string[] = []
  for (const [key, entry] of loaded()) {
    if (entry.tabId === tabId) {
      keys.push(key)
    }
  }
  return keys
}

export function hasTerminalSessionNames(): boolean {
  return loaded().size > 0
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== TERMINAL_SESSION_NAMES_STORAGE_KEY) {
    return
  }
  entries = readStored()
  notify()
}

export function subscribeTerminalSessionNames(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    // Another window may have written before anything here listened.
    entries = readStored()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
  }
}

export function resetTerminalSessionNamesForTest(): void {
  entries = null
  listeners.clear()
}
