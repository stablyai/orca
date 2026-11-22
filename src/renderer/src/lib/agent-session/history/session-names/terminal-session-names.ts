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
  /** Last time a tab took this name; eviction keeps recently used names. Older entries omit it. */
  usedAt?: number
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
    savedAt: record.savedAt,
    ...(typeof record.usedAt === 'number' && Number.isFinite(record.usedAt)
      ? { usedAt: record.usedAt }
      : {})
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

type Mutation =
  /** `keepNamedAt`: a handoff of the same name to another tab keeps when storage says it was named. */
  | { key: string; entry: TerminalSessionNameEntry; keepNamedAt?: true }
  | { key: string; forgetOwnedBy: string }

const lastUsedAt = (entry: TerminalSessionNameEntry) => entry.usedAt ?? entry.savedAt

// Changes storage refused (quota, a disabled store). Each write re-applies them to what it reads,
// so a refused clear is not undone by the next successful write; dropped once one lands.
let unsaved: Mutation[] = []

/** Applies mutations to `current`; `resolved` (when given) receives each as it was decided, with
 *  the naming time a handoff kept, so a refused one replays as decided rather than as asked. */
function applyMutations(
  current: Entries,
  mutations: readonly Mutation[],
  replay = false,
  resolved?: Mutation[]
): boolean {
  let changed = false
  for (const mutation of mutations) {
    resolved?.push(mutation)
    if ('entry' in mutation) {
      const stored = current.get(mutation.key)
      // A refused save replayed later must not undo a newer one another window made: a different
      // name is newer if it was named later; the same name moved to another tab, if moved later.
      if (
        replay &&
        stored &&
        (stored.title === mutation.entry.title
          ? lastUsedAt(stored) > lastUsedAt(mutation.entry)
          : stored.savedAt > mutation.entry.savedAt)
      ) {
        continue
      }
      if (
        stored?.title !== mutation.entry.title ||
        stored.tabId !== mutation.entry.tabId ||
        stored.agent !== mutation.entry.agent
      ) {
        // Decided against what storage holds now, not this window's possibly stale copy.
        const savedAt =
          mutation.keepNamedAt && stored?.title === mutation.entry.title
            ? stored.savedAt
            : mutation.entry.savedAt
        const entry = { ...mutation.entry, savedAt }
        current.set(mutation.key, entry)
        resolved?.splice(-1, 1, { key: mutation.key, entry })
        changed = true
      }
    } else if (current.get(mutation.key)?.tabId === mutation.forgetOwnedBy) {
      // Only while the expected tab still owns it: another window may have moved the name since.
      current.delete(mutation.key)
      changed = true
    }
  }
  return changed
}

/** What storage holds, with this window's refused changes still applied over it. */
function readCurrent(): Entries {
  const current = readStored()
  applyMutations(current, unsaved, true)
  return current
}

function loaded(): Entries {
  entries ??= readCurrent()
  return entries
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Re-read before writing so another window's saves and forgets are kept; apply only these changes. */
function commit(mutations: readonly Mutation[]): void {
  const current = readCurrent()
  const resolved: Mutation[] = []
  if (!applyMutations(current, mutations, false, resolved)) {
    entries = current
    return
  }
  if (current.size > TERMINAL_SESSION_NAMES_MAX_ENTRIES) {
    const oldestFirst = [...current.entries()].sort((a, b) => lastUsedAt(a[1]) - lastUsedAt(b[1]))
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
    unsaved = []
  } catch {
    // Quota or a disabled store: keep the changes for the next write to try again.
    unsaved = [...unsaved, ...resolved].slice(-TERMINAL_SESSION_NAMES_MAX_ENTRIES)
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
  // Handing the same name to another tab is not a newer name: keep when it was named.
  const now = Date.now()
  commit([
    {
      key,
      entry: { title, agent: args.agent, tabId: args.tabId, savedAt: now, usedAt: now },
      keepNamedAt: true
    }
  ])
}

export type TerminalSessionNameForget = { key: string; ownerTabId: string }

/** Forget names still owned by the expected tab; another window may have moved one since. */
export function forgetTerminalSessionNames(names: Iterable<TerminalSessionNameForget>): void {
  const wanted = [...names].filter(({ key, ownerTabId }) => loaded().get(key)?.tabId === ownerTabId)
  if (wanted.length === 0) {
    return
  }
  commit(wanted.map(({ key, ownerTabId }) => ({ key, forgetOwnedBy: ownerTabId })))
}

/** Every name this tab owns. */
export function terminalSessionNamesOwnedBy(tabId: string): TerminalSessionNameForget[] {
  const names: TerminalSessionNameForget[] = []
  for (const [key, entry] of loaded()) {
    if (entry.tabId === tabId) {
      names.push({ key, ownerTabId: tabId })
    }
  }
  return names
}

export function hasTerminalSessionNames(): boolean {
  return loaded().size > 0
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== TERMINAL_SESSION_NAMES_STORAGE_KEY) {
    return
  }
  entries = readCurrent()
  notify()
}

export function subscribeTerminalSessionNames(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    // Another window may have written before anything here listened.
    entries = readCurrent()
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
  unsaved = []
  listeners.clear()
}
