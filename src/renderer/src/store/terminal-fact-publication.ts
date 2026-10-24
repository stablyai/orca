import type { AppState } from './types'
import type { AgentStatusReadState } from './agent-status-observers'
import type { TerminalStoreGet, TerminalStoreSet } from './terminals/terminal-state'
const sourceReaders = {
  tabsByWorktree(state: Partial<AppState>) {
    return state.tabsByWorktree
  },
  unifiedTabsByWorktree(state: Partial<AppState>) {
    return state.unifiedTabsByWorktree
  },
  runtimePaneTitlesByTabId(state: Partial<AppState>) {
    return state.runtimePaneTitlesByTabId
  },
  paneForegroundAgentByPaneKey(state: Partial<AppState>) {
    return state.paneForegroundAgentByPaneKey
  }
}
export type TerminalFactSource = keyof typeof sourceReaders
const sources = Object.entries(sourceReaders)
type TerminalFactRoot = ReturnType<(typeof sourceReaders)[TerminalFactSource]>
type TerminalFactOwner = { getState: () => AgentStatusReadState }
type Hint = {
  before: TerminalFactRoot
  after: TerminalFactRoot
  keys: readonly string[]
  token: object
}
const publications = new WeakMap<
  TerminalFactOwner | TerminalStoreGet,
  Partial<Record<string, Hint>>
>()
export function terminalFactKeys(
  get: TerminalStoreGet,
  source: string,
  before: TerminalFactRoot,
  after: TerminalFactRoot
): readonly string[] | undefined {
  const hint = publications.get(publicationKey(get))?.[source]
  return hint && hint.before === before && hint.after === after ? hint.keys : undefined
}
export function terminalFactSetter(
  set: TerminalStoreSet,
  get: TerminalStoreGet,
  keys: readonly string[]
): (update: (state: AppState) => Partial<AppState>) => void {
  return (update) => {
    const token = {}
    const slots = publications.get(publicationKey(get)) ?? {}
    publications.set(publicationKey(get), slots)
    try {
      set((state) => {
        const patch = update(state)
        for (const [source, readSource] of sources) {
          const next = readSource(patch)
          if (next && next !== readSource(state)) {
            slots[source] = { before: readSource(state), after: next, keys, token }
          }
        }
        return patch
      })
    } finally {
      for (const [source] of sources) {
        if (slots[source]?.token === token) {
          delete slots[source]
        }
      }
      if (sources.every(([source]) => !slots[source])) {
        publications.delete(publicationKey(get))
      }
    }
  }
}

const getterKeys = new WeakMap<TerminalStoreGet, TerminalFactOwner>()
function publicationKey(get: TerminalStoreGet): TerminalFactOwner | TerminalStoreGet {
  return getterKeys.get(get) ?? get
}
export function bindTerminalFactGetters(
  key: TerminalFactOwner,
  ...getters: TerminalStoreGet[]
): void {
  for (const get of getters) {
    getterKeys.set(get, key)
  }
}
export type CapturedTerminalFacts = Partial<Record<TerminalFactSource, readonly string[]>>
export function captureTerminalFacts(
  get: TerminalStoreGet,
  previous: AppState,
  next: AppState
): CapturedTerminalFacts {
  const facts: Record<string, readonly string[]> = {}
  for (const [source, readSource] of sources) {
    if (readSource(previous) !== readSource(next)) {
      const keys = terminalFactKeys(get, source, readSource(previous), readSource(next))
      if (keys) {
        facts[source] = [...keys]
      }
    }
  }
  return facts
}
