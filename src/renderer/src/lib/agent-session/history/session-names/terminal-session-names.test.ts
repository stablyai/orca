// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_SESSION_NAMES_MAX_ENTRIES,
  TERMINAL_SESSION_NAMES_STORAGE_KEY,
  forgetTerminalSessionNames,
  getSavedTerminalSessionName,
  getTerminalSessionNameEntry,
  normalizeTerminalSessionName,
  resetTerminalSessionNamesForTest,
  saveTerminalSessionName,
  subscribeTerminalSessionNames,
  terminalSessionNameKey
} from './terminal-session-names'

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(TERMINAL_SESSION_NAMES_STORAGE_KEY) ?? '{}')
}

function save(sessionId: string, title: string, tabId = 'tab-1', agent: 'claude' = 'claude') {
  saveTerminalSessionName({
    executionHostId: 'local',
    sessionId,
    agent,
    tabId,
    title
  })
}

describe('terminal session names', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves, reads per host, and persists a name', () => {
    save('s1', 'Fix auth bug')
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Fix auth bug')
    expect(getSavedTerminalSessionName('runtime:other', 'claude', 's1')).toBeNull()
    expect(getSavedTerminalSessionName('local', 'codex', 's1')).toBeNull()
    resetTerminalSessionNamesForTest()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Fix auth bug')
  })

  it('matches OpenCode sessions listed under either OpenCode agent', () => {
    saveTerminalSessionName({
      executionHostId: 'local',
      sessionId: 'oc',
      agent: 'opencode',
      tabId: 'tab-1',
      title: 'Docs'
    })
    expect(getSavedTerminalSessionName('local', 'opencode2', 'oc')).toBe('Docs')
  })

  it('normalizes names once so an unchanged name writes nothing', () => {
    const long = `  ${'x'.repeat(250)}\n`
    expect(normalizeTerminalSessionName(long)).toHaveLength(200)
    save('s1', long)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    save('s1', long)
    save('s1', 'x'.repeat(200))
    expect(setItem).not.toHaveBeenCalled()
  })

  it('keeps valid entries and drops malformed ones on load', () => {
    localStorage.setItem(
      TERMINAL_SESSION_NAMES_STORAGE_KEY,
      JSON.stringify({
        [terminalSessionNameKey('local', 'good')]: {
          title: ' Good ',
          agent: 'codex',
          tabId: 't',
          savedAt: 1
        },
        [terminalSessionNameKey('local', 'bad-agent')]: {
          title: 'x',
          agent: 'nope',
          tabId: 't',
          savedAt: 1
        },
        [terminalSessionNameKey('local', 'no-title')]: {
          title: '  ',
          agent: 'codex',
          tabId: 't',
          savedAt: 1
        },
        'no-separator': { title: 'x', agent: 'codex', tabId: 't', savedAt: 1 }
      })
    )
    expect(getSavedTerminalSessionName('local', 'codex', 'good')).toBe('Good')
    expect(getTerminalSessionNameEntry('local', 'bad-agent')).toBeUndefined()
    expect(getTerminalSessionNameEntry('local', 'no-title')).toBeUndefined()

    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, '{not json')
    resetTerminalSessionNamesForTest()
    expect(getTerminalSessionNameEntry('local', 'good')).toBeUndefined()
  })

  it("keeps another window's writes when saving and forgetting", () => {
    save('mine', 'Mine')
    // Another window adds a name this window has not loaded.
    const other = stored()
    other[terminalSessionNameKey('local', 'theirs')] = {
      title: 'Theirs',
      agent: 'claude',
      tabId: 'tab-2',
      savedAt: 2
    }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('mine2', 'Mine 2')
    expect(Object.keys(stored())).toHaveLength(3)
    forgetTerminalSessionNames([
      { key: terminalSessionNameKey('local', 'mine'), ownerTabId: 'tab-1' }
    ])
    expect(Object.keys(stored()).sort()).toEqual(
      [terminalSessionNameKey('local', 'mine2'), terminalSessionNameKey('local', 'theirs')].sort()
    )
  })

  it('does not forget a name another window moved to a different tab', () => {
    save('s1', 'Mine', 'tab-a')
    const key = terminalSessionNameKey('local', 's1')
    // Another window moves the name to tab-b before this window hears of it.
    const other = stored()
    other[key] = { title: 'Theirs', agent: 'claude', tabId: 'tab-b', savedAt: Date.now() + 1 }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    forgetTerminalSessionNames([{ key, ownerTabId: 'tab-a' }])
    expect(stored()[key]).toMatchObject({ title: 'Theirs', tabId: 'tab-b' })
  })

  it('does not bring back a cleared name when storage refused the clear', () => {
    save('s1', 'Cleared later', 'tab-1')
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    forgetTerminalSessionNames([
      { key: terminalSessionNameKey('local', 's1'), ownerTabId: 'tab-1' }
    ])
    // The clear really was refused: storage still holds the name.
    expect(stored()[terminalSessionNameKey('local', 's1')]).toBeDefined()
    expect(setItem).toHaveBeenCalled()
    setItem.mockRestore()
    // The next write lands, and carries the refused clear with it.
    save('s2', 'Other', 'tab-2')
    expect(stored()[terminalSessionNameKey('local', 's1')]).toBeUndefined()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBeNull()
  })

  it("a refused save replayed later does not undo another window's newer save", () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    save('s1', 'Mine, refused', 'tab-1')
    setItem.mockRestore()
    // Another window saves a newer name for the same session.
    const key = terminalSessionNameKey('local', 's1')
    const other = stored()
    other[key] = { title: 'Theirs', agent: 'claude', tabId: 'tab-2', savedAt: now + 1_000 }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('s2', 'Unrelated', 'tab-3')
    expect(stored()[key]).toMatchObject({ title: 'Theirs', tabId: 'tab-2' })
  })

  it('keeps when a name was given when only its owner tab changes', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('s1', 'Fix auth bug', 'closed-tab')
    const first = getTerminalSessionNameEntry('local', 's1')
    save('s1', 'Fix auth bug', 'tab-new')
    expect(getTerminalSessionNameEntry('local', 's1')).toMatchObject({
      title: 'Fix auth bug',
      tabId: 'tab-new',
      savedAt: first?.savedAt
    })
    save('s1', 'Renamed', 'tab-new')
    expect(getTerminalSessionNameEntry('local', 's1')?.savedAt).toBeGreaterThan(first?.savedAt ?? 0)
  })

  it('evicts the least recently used names, counting a tab taking a name as use', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('kept', 'Resumed often', 'tab-old')
    for (let index = 0; index < TERMINAL_SESSION_NAMES_MAX_ENTRIES - 1; index++) {
      save(`filler-${index}`, `Name ${index}`)
    }
    // A resumed tab takes the old name, then more names arrive past the limit.
    save('kept', 'Resumed often', 'tab-new')
    save('newest', 'Newest')
    const keys = Object.keys(stored())
    expect(keys).toContain(terminalSessionNameKey('local', 'kept'))
    expect(keys).not.toContain(terminalSessionNameKey('local', 'filler-0'))
  })

  it("a refused handoff replayed later does not undo another window's newer handoff", () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('s1', 'X', 'tab-a')
    const named = getTerminalSessionNameEntry('local', 's1')
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    save('s1', 'X', 'tab-b')
    setItem.mockRestore()
    // Another window hands the same name to tab-c afterwards; the naming time is unchanged.
    const key = terminalSessionNameKey('local', 's1')
    const other = stored()
    other[key] = { ...named, tabId: 'tab-c', usedAt: now + 1_000 }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('s2', 'Unrelated', 'tab-3')
    expect(stored()[key]).toMatchObject({ title: 'X', tabId: 'tab-c' })
  })

  it("a refused rename replayed later is not undone by another window's handoff of the old name", () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('s1', 'X', 'tab-a')
    const named = getTerminalSessionNameEntry('local', 's1')
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    save('s1', 'Y', 'tab-a')
    setItem.mockRestore()
    // Another window then hands the old name X to tab-c: used later, but named before Y.
    const key = terminalSessionNameKey('local', 's1')
    const other = stored()
    other[key] = { ...named, tabId: 'tab-c', usedAt: now + 1_000 }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('s2', 'Unrelated', 'tab-3')
    expect(stored()[key]).toMatchObject({ title: 'Y', tabId: 'tab-a' })
  })

  it('a refused handoff replays with the naming time it kept, so it cannot beat a newer rename', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('s1', 'X', 'tab-a')
    const key = terminalSessionNameKey('local', 's1')
    const namedAt = getTerminalSessionNameEntry('local', 's1')?.savedAt ?? 0
    // This window's handoff of X to tab-b is refused.
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    save('s1', 'X', 'tab-b')
    setItem.mockRestore()
    // Another window's rename to Y, made after X was named but before this handoff, lands first.
    const other = stored()
    other[key] = {
      title: 'Y',
      agent: 'claude',
      tabId: 'tab-c',
      savedAt: namedAt + 1,
      usedAt: namedAt + 1
    }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('s2', 'Unrelated', 'tab-3')
    expect(stored()[key]).toMatchObject({ title: 'Y', tabId: 'tab-c' })
  })

  it('a handoff keeps the naming time storage holds, not a stale copy', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('s1', 'X', 'tab-a')
    // Another window renames the session to Y and back to X later; this window has not heard.
    const key = terminalSessionNameKey('local', 's1')
    const other = stored()
    other[key] = { title: 'X', agent: 'claude', tabId: 'tab-c', savedAt: 3_000, usedAt: 3_000 }
    localStorage.setItem(TERMINAL_SESSION_NAMES_STORAGE_KEY, JSON.stringify(other))
    save('s1', 'X', 'tab-b')
    expect(stored()[key]).toMatchObject({ tabId: 'tab-b', savedAt: 3_000 })
  })

  it("refreshes and notifies on another window's storage event", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalSessionNames(listener)
    localStorage.setItem(
      TERMINAL_SESSION_NAMES_STORAGE_KEY,
      JSON.stringify({
        [terminalSessionNameKey('local', 's9')]: {
          title: 'Elsewhere',
          agent: 'claude',
          tabId: 't',
          savedAt: 1
        }
      })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: TERMINAL_SESSION_NAMES_STORAGE_KEY }))
    expect(listener).toHaveBeenCalled()
    expect(getSavedTerminalSessionName('local', 'claude', 's9')).toBe('Elsewhere')
    unsubscribe()
  })
})
