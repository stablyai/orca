import { describe, expect, it } from 'vitest'
import {
  getNextTabAcrossAllTypes,
  getNextTabWithinActiveType,
  type TypeCyclableTab
} from './tab-type-cycle'

const mixedTabs: TypeCyclableTab[] = [
  { type: 'terminal', id: 'term-1' },
  { type: 'editor', id: 'file-1', tabId: 'tab-file-1' },
  { type: 'browser', id: 'browser-1' },
  { type: 'terminal', id: 'term-2' },
  { type: 'editor', id: 'file-2', tabId: 'tab-file-2' },
  { type: 'browser', id: 'browser-2' }
]

describe('getNextTabWithinActiveType', () => {
  it('cycles only terminal tabs when a terminal is active', () => {
    expect(
      getNextTabWithinActiveType({
        tabs: mixedTabs,
        activeTabType: 'terminal',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toEqual({ type: 'terminal', id: 'term-2' })
  })

  it('cycles only editor tabs when an editor is active', () => {
    expect(
      getNextTabWithinActiveType({
        tabs: mixedTabs,
        activeTabType: 'editor',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toEqual({ type: 'editor', id: 'file-2', tabId: 'tab-file-2' })
  })

  it('cycles only browser tabs when a browser is active', () => {
    expect(
      getNextTabWithinActiveType({
        tabs: mixedTabs,
        activeTabType: 'browser',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toEqual({ type: 'browser', id: 'browser-2' })
  })

  it('returns null when the active type has a single tab', () => {
    expect(
      getNextTabWithinActiveType({
        tabs: [
          { type: 'terminal', id: 'term-1' },
          { type: 'editor', id: 'file-1' },
          { type: 'browser', id: 'browser-1' }
        ],
        activeTabType: 'browser',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toBeNull()
  })

  it('uses direction-aware fallback when the active tab is missing from the active type', () => {
    const terminalTabs: TypeCyclableTab[] = [
      { type: 'terminal', id: 'term-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'terminal', id: 'term-3' }
    ]

    expect(
      getNextTabWithinActiveType({
        tabs: terminalTabs,
        activeTabType: 'terminal',
        activeTabId: null,
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: -1
      })
    ).toEqual({ type: 'terminal', id: 'term-3' })

    expect(
      getNextTabWithinActiveType({
        tabs: terminalTabs,
        activeTabType: 'terminal',
        activeTabId: null,
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toEqual({ type: 'terminal', id: 'term-1' })
  })

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
  it('cycles to the next tab regardless of type when a terminal is active', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: mixedTabs,
        activeTabType: 'terminal',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: 1
      })
    ).toEqual({ type: 'editor', id: 'file-1', tabId: 'tab-file-1' })
  })

  it('wraps from the last tab back to the first', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: mixedTabs,
        activeTabType: 'browser',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-2',
        direction: 1
      })
    ).toEqual({ type: 'terminal', id: 'term-1' })
  })

  it('cycles backward across types', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: mixedTabs,
        activeTabType: 'editor',
        activeTabId: 'term-1',
        activeFileId: 'file-1',
        activeBrowserTabId: 'browser-1',
        direction: -1
      })
    ).toEqual({ type: 'terminal', id: 'term-1' })
  })

  it('returns null when only one tab exists total', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: [{ type: 'terminal', id: 'term-1' }],
        activeTabType: 'terminal',
        activeTabId: 'term-1',
        activeFileId: null,
        activeBrowserTabId: null,
        direction: 1
      })
    ).toBeNull()
  })

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

  it('uses direction-aware fallback when the active tab id is missing', () => {
    expect(
      getNextTabAcrossAllTypes({
        tabs: mixedTabs,
        activeTabType: 'terminal',
        activeTabId: 'nonexistent',
        activeFileId: null,
        activeBrowserTabId: null,
        direction: 1
      })
    ).toEqual(mixedTabs[0])

    expect(
      getNextTabAcrossAllTypes({
        tabs: mixedTabs,
        activeTabType: 'terminal',
        activeTabId: 'nonexistent',
        activeFileId: null,
        activeBrowserTabId: null,
        direction: -1
      })
    ).toEqual(mixedTabs.at(-1))
  })
})
