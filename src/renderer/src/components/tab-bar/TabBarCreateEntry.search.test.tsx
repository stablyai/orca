// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import { QUICK_OPEN_QUERY_MAX_BYTES } from '../quick-open-search'

const fileListMock = vi.hoisted(() => ({
  current: { files: [] as string[], loading: false, loadError: null as string | null }
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => fileListMock.current
}))

const tabSearchMock = vi.hoisted(() => ({
  calls: [] as { enabled: boolean; query: string }[],
  results: [] as unknown[]
}))
vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: ({ enabled, query }: { enabled: boolean; query: string }) => {
    tabSearchMock.calls.push({ enabled, query })
    return { query, results: tabSearchMock.results }
  }
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function renderEntry(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBarCreateEntry
          worktreeId="wt"
          groupId="g"
          menuOpen
          onOpenEntry={vi.fn().mockResolvedValue(undefined)}
          {...props}
        />
      </TooltipProvider>
    )
  })
}

function setQuery(value: string): void {
  const input = container.querySelector('input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function submit(): void {
  act(() => {
    container
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

function press(key: string): void {
  act(() => {
    container
      .querySelector('input')!
      .dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function rowTexts(): string[] {
  return [...container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '')
}

function seedBrowserHistory(url: string, title: string): void {
  useAppStore.setState({
    browserUrlHistory: [
      { url, normalizedUrl: url.replace(/\/$/, ''), title, lastVisitedAt: 1, visitCount: 1 }
    ]
  })
}

beforeEach(() => {
  fileListMock.current = { files: [], loading: false, loadError: null }
  tabSearchMock.calls = []
  tabSearchMock.results = []
  useAppStore.setState(
    { ...useAppStore.getInitialState(), browserDefaultSearchEngine: null } as AppState,
    true
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('TabBarCreateEntry search behavior', () => {
  it.each([false, true])('searches weak file matches on Enter (delayed listing: %s)', (delayed) => {
    const readyListing = {
      files: [
        'tests/e2e/terminal-split-activation-latency-main-probe.ts',
        'src/main/linear/issue-context-inline-media.test.ts',
        'src/renderer/src/components/editor/combined-diff/resolve-changes/combined-diff-section-cache-match.ts'
      ],
      loading: false,
      loadError: null
    }
    fileListMock.current = delayed ? { files: [], loading: true, loadError: null } : readyListing
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('asciinema')

    if (delayed) {
      expect(container.querySelector('[aria-selected="true"]')).toBeNull()
      submit()
      expect(onOpenEntry).not.toHaveBeenCalled()
      fileListMock.current = readyListing
      renderEntry({ onOpenEntry })
    }

    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Google')
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain(
      'Search Google'
    )
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'search', engine: 'google', query: 'asciinema' }
      })
    )
  })

  it.each([false, true])(
    'keeps a typed host and its pages above unrelated files (visited root: %s)',
    (visitedRoot) => {
      fileListMock.current.files = [
        'mobile/rpc-foundation/goldens/matrix-transport.capability-probe-status.get-1.json',
        'mobile/rpc-foundation/goldens/matrix-files.terminal-path-tap-files.open-1.json',
        'mobile/rpc-foundation/goldens/matrix-files.terminal-path-tap-files.resolveterminalpath-1.json'
      ]
      const url = visitedRoot ? 'https://linear.app/' : 'https://linear.app/acme/issues'
      seedBrowserHistory(url, 'Linear')
      useAppStore.setState((state) => ({
        browserUrlHistory: [
          {
            url: 'https://linear.app/acme/inbox',
            normalizedUrl: 'https://linear.app/acme/inbox',
            title: 'Linear inbox',
            lastVisitedAt: 2,
            visitCount: 10
          },
          ...state.browserUrlHistory
        ]
      }))
      const onOpenEntry = vi.fn().mockResolvedValue(undefined)
      renderEntry({ onOpenEntry })
      setQuery('linear.app')

      const rows = rowTexts()
      const pageIndex = rows.findIndex((row) => row.includes('Open page'))
      expect(pageIndex).toBeGreaterThanOrEqual(0)
      expect(rows.findIndex((row) => row.includes('Open file'))).toBeGreaterThan(pageIndex)
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('linear.app')
      submit()
      expect(onOpenEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: visitedRoot
            ? { kind: 'explicit-url', url }
            : { kind: 'host-url', url: 'https://linear.app/' }
        })
      )
    }
  )

  it('still opens a visited host above a filename that contains it', () => {
    fileListMock.current.files = ['config/localhost.ts']
    seedBrowserHistory('http://localhost/', 'Local')
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('localhost')

    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'explicit-url', url: 'http://localhost/' }
      })
    )
  })

  it.each([
    { loading: false, loadError: null },
    { loading: true, loadError: null },
    { loading: false, loadError: 'scan failed' }
  ])('submits the exact visited URL ahead of a more popular subpage (index: %j)', (fileIndex) => {
    fileListMock.current = { files: [], ...fileIndex }
    const url = 'https://x.com/bonafide714/status/211363866'
    seedBrowserHistory(url, 'Nico on X')
    useAppStore.setState((state) => ({
      browserUrlHistory: [
        {
          url: `${url}/photo/1`,
          normalizedUrl: `${url}/photo/1`,
          title: 'Photo on X',
          lastVisitedAt: 2,
          visitCount: 10
        },
        ...state.browserUrlHistory
      ]
    }))
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery(url)

    const firstOption = container.querySelector('[role="option"]')
    expect(firstOption?.textContent).toContain('Open page')
    expect(firstOption?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('input')?.getAttribute('aria-activedescendant')).toBe(
      firstOption?.id
    )

    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ classification: { kind: 'explicit-url', url } })
    )
  })

  it('waits for files before selecting a visited host and stays blocked after reindexing', () => {
    fileListMock.current = { files: [], loading: true, loadError: null }
    seedBrowserHistory('https://example.com/', 'Example')
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('example.com')

    expect(container.querySelector('[role="option"]')?.textContent).toContain('Open page')
    expect(container.querySelector('[aria-selected="true"]')).toBeNull()
    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()

    fileListMock.current = { files: ['example.com'], loading: false, loadError: null }
    renderEntry({ onOpenEntry })
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Open file')

    fileListMock.current = { files: [], loading: true, loadError: null }
    renderEntry({ onOpenEntry })
    fileListMock.current = { files: [], loading: false, loadError: null }
    renderEntry({ onOpenEntry })
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Open page')
    expect(container.querySelector('[aria-selected="true"]')).toBeNull()
    expect(container.querySelector('input')?.getAttribute('aria-activedescendant')).toBeNull()
    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()

    press('ArrowDown')
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'explicit-url', url: 'https://example.com/' }
      })
    )
  })

  // A code-host page title carries the file path, so it matches path queries too.
  it.each([false, true])(
    'keeps a matching page below local rows for a path query (typed: %s)',
    (typed) => {
      fileListMock.current.files = [
        'src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx',
        'src/renderer/src/components/tab-bar/TabBarCreateEntryRow.tsx'
      ]
      seedBrowserHistory(
        'https://github.com/acme/app/blob/main/src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx',
        'app/src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx at main · acme/app'
      )
      const onOpenEntry = vi.fn().mockResolvedValue(undefined)
      renderEntry({ onOpenEntry })
      const query = 'components/tab-bar/TabBarCreate'
      if (typed) {
        for (let length = 1; length <= query.length; length += 1) {
          setQuery(query.slice(0, length))
        }
      } else {
        setQuery(query)
      }

      const rows = rowTexts()
      const pageIndex = rows.findIndex((row) => row.includes('Open page'))
      expect(pageIndex).toBeGreaterThan(rows.findLastIndex((row) => row.includes('Open file')))
      submit()
      expect(onOpenEntry).toHaveBeenCalledOnce()
      expect(onOpenEntry.mock.calls[0]?.[0].classification.kind).not.toBe('explicit-url')
    }
  )

  it.each(['a', 'ab', 'asciinema'])('waits for an exact filename before arming %s', (query) => {
    fileListMock.current = { files: [], loading: true, loadError: null }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery(query)

    expect(container.querySelector('[aria-selected="true"]')).toBeNull()
    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()

    fileListMock.current = { files: [`docs/${query}`], loading: false, loadError: null }
    renderEntry({ onOpenEntry })
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Open file')
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: {
          kind: 'existing-file',
          matchKind: 'exact-basename',
          relativePath: `docs/${query}`
        }
      })
    )
  })

  it('tracks the configured provider and submits its exact classification', () => {
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('react hooks')
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Google')

    act(() => useAppStore.setState({ browserDefaultSearchEngine: 'bing' }))
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Bing')
    submit()

    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'search', engine: 'bing', query: 'react hooks' }
      })
    )
  })

  it('searches a phrase on Enter while the file index is still loading', () => {
    fileListMock.current = { files: [], loading: true, loadError: null }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('natural language')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Google')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading files...')
    expect(container.querySelector('[aria-selected="true"]')).not.toBeNull()

    submit()
    expect(onOpenEntry).toHaveBeenCalledOnce()
  })

  it('requires an explicit choice for text the loading index could still match', () => {
    fileListMock.current = { files: [], loading: true, loadError: null }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('notes.md draft')

    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Google')
    expect(container.querySelector('[aria-selected="true"]')).toBeNull()

    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Choose an action.')

    press('ArrowDown')
    submit()
    expect(onOpenEntry).toHaveBeenCalledOnce()
  })

  it('arms network actions once the index fails, since no file match can arrive', () => {
    fileListMock.current = { files: [], loading: false, loadError: 'scan failed' }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('example.com')

    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Open URL')
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ classification: expect.objectContaining({ kind: 'host-url' }) })
    )
  })

  it('does not auto-open a host-like filename while the file index is unresolved', () => {
    fileListMock.current = { files: [], loading: true, loadError: null }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('example.com')

    expect(container.querySelector('[role="option"]')?.textContent).toContain('Open URL')
    expect(container.querySelector('[aria-selected="true"]')).toBeNull()
    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()
  })

  it('disables the active submission and exposes failures to assistive technology', async () => {
    let rejectOpen: ((error: Error) => void) | undefined
    const onOpenEntry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject
        })
    )
    renderEntry({ onOpenEntry })
    setQuery('react hooks')
    submit()

    // Read-only rather than disabled so the pending input keeps keyboard focus.
    expect(container.querySelector('input')?.disabled).toBe(false)
    expect(container.querySelector('input')?.readOnly).toBe(true)
    expect(container.querySelector('input')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true)
    expect(container.querySelector('[role="option"] .animate-spin')).not.toBeNull()

    await act(async () => rejectOpen?.(new Error('Search failed safely.')))

    const input = container.querySelector('input')!
    expect(input.readOnly).toBe(false)
    expect(input.getAttribute('aria-busy')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-errormessage')).toBe('tab-create-entry-error')
    expect(container.querySelector('#tab-create-entry-error')?.textContent).toContain(
      'Search failed safely.'
    )
  })

  it('ignores completion from a previous menu session', async () => {
    let resolveOpen: (() => void) | undefined
    const onDidOpenEntry = vi.fn()
    const onOpenEntry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
    )
    renderEntry({ onDidOpenEntry, onOpenEntry })
    setQuery('react hooks')
    submit()

    renderEntry({ menuOpen: false, onDidOpenEntry, onOpenEntry })
    renderEntry({ menuOpen: true, onDidOpenEntry, onOpenEntry })
    await act(async () => resolveOpen?.())

    expect(onDidOpenEntry).not.toHaveBeenCalled()
    expect(container.querySelector('input')?.readOnly).toBe(false)
  })

  it('does not arm ordinary search when a ranked file disappears asynchronously', () => {
    fileListMock.current = { files: ['project codename'], loading: false, loadError: null }
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('project codename')
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Open file')

    fileListMock.current = { files: [], loading: true, loadError: null }
    renderEntry({ onOpenEntry })
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Search Google')
    expect(container.querySelector('[aria-selected="true"]')).toBeNull()
    expect(container.querySelector('input')?.getAttribute('aria-activedescendant')).toBeNull()

    submit()
    expect(onOpenEntry).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Choose an action.')

    press('ArrowDown')
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ classification: expect.objectContaining({ kind: 'search' }) })
    )
  })

  it('makes forced search the only category and disables open-tab matching', () => {
    fileListMock.current = { files: ['gem'], loading: false, loadError: null }
    tabSearchMock.results = [
      {
        id: 'open-tab:workspace:tab-1',
        title: 'gem tab',
        contentType: 'terminal',
        worktreeId: 'wt',
        tabId: 'tab-1',
        entityId: 'term-1',
        groupId: 'g',
        relativePath: null
      }
    ]
    const menuOptions: TabCreateMenuOption[] = [
      { id: 'new-browser', kind: 'new-browser', keywords: ['gem'], label: 'Gem action' }
    ]
    const agentOptions: TabAgentLaunchOption[] = [
      { agent: 'gemini', aliases: ['gem'], label: 'Gemini' }
    ]
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ agentOptions, menuOptions, onOpenEntry })
    setQuery('?gem')

    const rows = container.querySelectorAll('[role="option"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Search Google')
    expect(tabSearchMock.calls.at(-1)).toEqual({ enabled: false, query: '' })
    submit()
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { kind: 'search', engine: 'google', query: 'gem' }
      })
    )
  })

  it('treats a bare search prefix as a prompt rather than a submission error', () => {
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })
    setQuery('?')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    submit()

    expect(onOpenEntry).not.toHaveBeenCalled()
    expect(container.querySelector('#tab-create-entry-error')).toBeNull()
    expect(container.querySelector('input')?.getAttribute('aria-errormessage')).toBeNull()
  })

  it('blocks oversized forced input without surfacing global actions', () => {
    renderEntry({
      menuOptions: [
        { id: 'new-browser', kind: 'new-browser', keywords: ['x'], label: 'New Browser' }
      ],
      agentOptions: [{ agent: 'gemini', aliases: ['x'], label: 'Gemini' }]
    })
    setQuery(`?${'x'.repeat(QUICK_OPEN_QUERY_MAX_BYTES)}`)

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(container.textContent).toContain('Search text is too large.')
    expect(tabSearchMock.calls.at(-1)).toEqual({ enabled: false, query: '' })
  })
})
