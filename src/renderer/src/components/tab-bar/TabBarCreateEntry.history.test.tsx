// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BrowserHistoryEntry } from '../../../../shared/browser-workspace-types'
import type { OpenTabSearchResult } from './open-tab-search'
import type * as ReactModule from 'react'
import type { TabCreateEntryArgs, TabEntryOption } from './tab-create-entry-action'

const entryOptionsMock = vi.hoisted(() => ({ options: [] as TabEntryOption[] }))
const pathLikeMock = vi.hoisted(() => ({ value: false }))
vi.mock('./tab-create-entry-action', () => ({
  getTabEntryOptions: () => entryOptionsMock.options,
  createTabEntryAllowAbsolutePathsSelector: () => () => true,
  isTabEntryAbsolutePathLike: () => pathLikeMock.value
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: [],
    loading: false,
    loadError: null,
    truncated: false
  })
}))
vi.mock('@/lib/agent-catalog', () => ({ getAgentCatalog: () => [], AgentIcon: () => null }))

// `hold` pins deferred rows to the query they were built from, standing in for
// the hook's useDeferredValue so later keystrokes leave them stale.
const historyStoreMock = vi.hoisted(() => ({
  entries: [] as BrowserHistoryEntry[],
  hold: null as string | null,
  listeners: new Set<() => void>()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        browserUrlHistory: historyStoreMock.entries,
        browserDefaultSearchEngine: 'google',
        getKnownWorktreeById: () => ({ path: '/tmp/wt' })
      }),
    { getState: () => ({ browserUrlHistory: historyStoreMock.entries }) }
  )
}))
vi.mock('react', async () => {
  const react = await vi.importActual<typeof ReactModule>('react')
  return {
    ...react,
    useDeferredValue: (value: string) => historyStoreMock.hold ?? value
  }
})

const tabResultsMock = vi.hoisted(() => ({ results: [] as OpenTabSearchResult[] }))
vi.mock('./use-tab-create-entry-search-results', () => ({
  useTabCreateEntrySearchResults: ({ enabled }: { enabled: boolean }) =>
    enabled ? tabResultsMock.results : []
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function historyEntry(overrides: Partial<BrowserHistoryEntry> & { url: string }) {
  return {
    normalizedUrl: overrides.url.replace(/\/$/, ''),
    title: 'Linear',
    lastVisitedAt: Date.now(),
    visitCount: 4,
    ...overrides
  }
}

const linear = historyEntry({
  url: 'https://linear.app/acme/team/ORC/active',
  title: 'ORC · Active issues'
})

let container: HTMLDivElement
let root: Root
let onOpenEntry: Mock<(args: TabCreateEntryArgs) => Promise<void>>

function mount(): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={onOpenEntry} />
      </TooltipProvider>
    )
  })
}

function setQuery(value: string): void {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('input not found')
  }
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function pressKey(key: string): void {
  const form = container.querySelector('form')
  if (!form) {
    throw new Error('form not found')
  }
  act(() => {
    form.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    )
  })
}

function submitForm(): void {
  const form = container.querySelector('form')
  if (!form) {
    throw new Error('form not found')
  }
  act(() => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

function rowTexts(): string[] {
  return [...container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  entryOptionsMock.options = []
  pathLikeMock.value = false
  tabResultsMock.results = []
  historyStoreMock.entries = [linear]
  historyStoreMock.hold = null
  onOpenEntry = vi.fn().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TabBarCreateEntry browser history rows', () => {
  it('holds history back until the query is at least two characters', () => {
    mount()

    setQuery('l')
    expect(rowTexts().some((text) => text.includes('Open page'))).toBe(false)

    setQuery('li')
    expect(rowTexts()[0]).toContain('Open page')
    expect(rowTexts()[0]).toContain('ORC · Active issues')
    expect(rowTexts()[0]).toContain('linear.app/acme/team/ORC/active')
  })

  it('shows no history for an empty omnibox', () => {
    mount()

    expect(rowTexts().some((text) => text.includes('Open page'))).toBe(false)
  })

  it('uses the favicon captured with a history entry', () => {
    const faviconUrl = 'https://linear.app/favicon.ico'
    historyStoreMock.entries = [historyEntry({ ...linear, faviconUrl })]
    mount()

    setQuery('linear')

    expect(container.querySelector<HTMLImageElement>('[role="option"] img')?.src).toBe(faviconUrl)
  })

  it('skips history for a path-shaped query and for a forced search', () => {
    pathLikeMock.value = true
    mount()
    setQuery('/Users/jane/linear')
    expect(rowTexts().some((text) => text.includes('Open page'))).toBe(false)

    pathLikeMock.value = false
    setQuery('?linear')
    expect(rowTexts().some((text) => text.includes('Open page'))).toBe(false)
  })

  it('yields to the switch row when the page is already open in a browser tab', () => {
    tabResultsMock.results = [
      {
        executionHostId: 'local',
        source: 'browser',
        id: 'open-tab:browser:page-1',
        title: 'ORC · Active issues',
        matchedText: null,
        worktreeId: 'wt',
        contentType: 'browser',
        pageId: 'page-1',
        workspaceId: 'ws-1',
        url: 'https://linear.app/acme/team/ORC/active',
        faviconUrl: null
      }
    ]
    mount()

    setQuery('linear')

    const rows = rowTexts()
    expect(rows[0]).toContain('Switch to tab')
    expect(rows.some((text) => text.includes('Open page'))).toBe(false)
  })

  it('opens the visited url through the entry path when the row is submitted', () => {
    mount()
    setQuery('linear')
    pressKey('ArrowDown')

    submitForm()

    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'explicit-url', url: 'https://linear.app/acme/team/ORC/active' },
        worktreeId: 'wt',
        groupId: 'g'
      })
    )
  })

  it('keeps arrow-key selection across a background history write', () => {
    historyStoreMock.entries = [linear, historyEntry({ url: 'https://linear.app/acme/inbox' })]
    mount()
    setQuery('linear')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    const selectedBefore = container.querySelector('[aria-selected="true"]')?.textContent

    // A committed navigation elsewhere replaces the store array mid-session.
    act(() => {
      historyStoreMock.entries = [
        historyEntry({ url: 'https://unrelated.example/page' }),
        ...historyStoreMock.entries
      ]
    })
    setQuery('linear ')

    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe(selectedBefore)
  })

  it('refuses to submit a row the visible query no longer matches', () => {
    mount()
    setQuery('linear')
    pressKey('ArrowDown')
    // The deferred pass is still describing "linear" while the input reads "zzz".
    historyStoreMock.hold = 'linear'
    setQuery('zzz')

    expect(rowTexts().some((text) => text.includes('Open page'))).toBe(false)
    submitForm()
    expect(onOpenEntry).not.toHaveBeenCalled()
  })
})
