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
  terminalSessionNameKey,
  terminalSessionNameKeysOwnedBy
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
    forgetTerminalSessionNames([terminalSessionNameKey('local', 'mine')])
    expect(Object.keys(stored()).sort()).toEqual(
      [terminalSessionNameKey('local', 'mine2'), terminalSessionNameKey('local', 'theirs')].sort()
    )
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

  it('lists the keys a tab owns and keeps only the newest entries', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    save('a', 'A', 'tab-a')
    save('b', 'B', 'tab-a')
    save('c', 'C', 'tab-c')
    expect(terminalSessionNameKeysOwnedBy('tab-a').sort()).toEqual(
      [terminalSessionNameKey('local', 'a'), terminalSessionNameKey('local', 'b')].sort()
    )

    for (let index = 0; index < TERMINAL_SESSION_NAMES_MAX_ENTRIES + 5; index++) {
      save(`bulk-${index}`, `Name ${index}`)
    }
    const keys = Object.keys(stored())
    expect(keys).toHaveLength(TERMINAL_SESSION_NAMES_MAX_ENTRIES)
    expect(keys).toContain(
      terminalSessionNameKey('local', `bulk-${TERMINAL_SESSION_NAMES_MAX_ENTRIES + 4}`)
    )
    expect(keys).not.toContain(terminalSessionNameKey('local', 'a'))
  })
})
