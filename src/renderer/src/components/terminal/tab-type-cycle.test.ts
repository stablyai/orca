import { describe, expect, it } from 'vitest'
import { getNextTabAcrossAllTypes, getNextTabWithinActiveType } from './tab-type-cycle'

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
