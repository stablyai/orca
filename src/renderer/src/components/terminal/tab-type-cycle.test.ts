import { describe, expect, it } from 'vitest'
import {
  getNextTabAcrossAllTypes,
  getNextTerminalCycleTab,
  getNextTabWithinActiveType,
  type TypeCyclableTab
} from './tab-type-cycle'

describe('getNextTabWithinActiveType', () => {
  it('uses the active group tab id for split editor duplicates', () => {
    expect(
      getNextTabWithinActiveType({
        tabs: [
          { type: 'editor', id: 'file-a', tabId: 'tab-a' },
          { type: 'terminal', id: 'term-1' },
          { type: 'editor', id: 'file-a', tabId: 'tab-b' },
          { type: 'editor', id: 'file-c', tabId: 'tab-c' }
        ],
        activeTabType: 'editor',
        activeTabId: 'term-1',
        activeFileId: 'file-a',
        activeBrowserTabId: 'browser-1',
        activeGroupTabId: 'tab-b',
        direction: 1
      })
    ).toEqual({ type: 'editor', id: 'file-c', tabId: 'tab-c' })
  })
})

describe('getNextTabAcrossAllTypes', () => {
  it('prefers the active group tab id to disambiguate split duplicates', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: [
          { type: 'editor', id: 'file-a', tabId: 'tab-a' },
          { type: 'terminal', id: 'term-1' },
          { type: 'editor', id: 'file-a', tabId: 'tab-b' },
          { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' }
        ],
        activeTabType: 'editor',
        activeTabId: 'term-1',
        activeFileId: 'file-a',
        activeBrowserTabId: null,
        activeGroupTabId: 'tab-b',
        direction: 1
      })
    ).toEqual({ type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' })
  })
})

describe('getNextTerminalCycleTab', () => {
  it('enters a sole chat from an editor but does not reactivate the same exact chat', () => {
    const chat: TypeCyclableTab = { type: 'agent-session', id: 'session', tabId: 'chat' }
    expect(getNextTerminalCycleTab([chat], { type: 'editor', id: 'session' }, 1)).toBe(chat)
    expect(getNextTerminalCycleTab([chat], chat, -1)).toBeNull()
  })

  it('prefers exact tab identity and otherwise distinguishes colliding entity kinds', () => {
    const tabs: TypeCyclableTab[] = [
      { type: 'terminal', id: 'same', tabId: 'terminal' },
      { type: 'agent-session', id: 'same', tabId: 'chat' },
      { type: 'terminal', id: 'same', tabId: 'terminal-copy' }
    ]
    expect(getNextTerminalCycleTab(tabs, tabs[1], 1)).toBe(tabs[2])
    expect(getNextTerminalCycleTab(tabs, { type: 'agent-session', id: 'same' }, -1)).toBe(tabs[0])
    expect(getNextTerminalCycleTab(tabs, tabs[2], 1)).toBe(tabs[0])
  })
})
