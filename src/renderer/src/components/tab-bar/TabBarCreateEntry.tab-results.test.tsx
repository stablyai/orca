// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OpenTabSearchResult } from './open-tab-search'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import type { TabEntryOption } from './tab-create-entry-action'

// Why: the real entry-action module pulls in runtime IPC + the app store; these
// tests only need a controllable option list beneath the tab rows.
const entryOptionsMock = vi.hoisted(() => ({ options: [] as TabEntryOption[] }))
vi.mock('./tab-create-entry-action', () => ({
  getTabEntryOptions: () => entryOptionsMock.options,
  createTabEntryAllowAbsolutePathsSelector: () => () => true,
  isTabEntryAbsolutePathLike: () => false
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [],
  AgentIcon: () => null
}))

// `hold` stands in for the hook's deferred query: rows the user has not seen yet.
const tabSearchMock = vi.hoisted(() => ({
  hold: false,
  resultsByQuery: {} as Record<string, unknown[]>
}))
vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: ({ enabled, query }: { enabled: boolean; query: string }) =>
    enabled && !tabSearchMock.hold ? (tabSearchMock.resultsByQuery[query.trim()] ?? []) : []
}))

// Selection routing itself stays real, so the focus handoff and failure messages
// under test are the shipped ones; only the palette activations are stubbed.
const activationMocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  browser: vi.fn(),
  simulator: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  queueBrowserFocusRequest: vi.fn()
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: activationMocks.workspace
}))
vi.mock('@/lib/browser-page-palette-activation', () => ({
  activateBrowserPagePaletteResult: activationMocks.browser
}))
vi.mock('@/lib/simulator-tab-palette-activation', () => ({
  activateSimulatorTabPaletteResult: activationMocks.simulator
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: activationMocks.focusTerminalTabSurface
}))
vi.mock('@/components/browser-pane/browser-focus', () => ({
  ORCA_BROWSER_FOCUS_REQUEST_EVENT: 'orca:browser-focus-request',
  queueBrowserFocusRequest: activationMocks.queueBrowserFocusRequest
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function terminalResult(overrides: Partial<OpenTabSearchResult> = {}): OpenTabSearchResult {
  return {
    source: 'workspace',
    id: 'open-tab:workspace:tab-1',
    title: 'Add tab search and jump in worktree',
    matchedText: null,
    worktreeId: 'wt',
    contentType: 'terminal',
    tabId: 'tab-1',
    entityId: 'term-1',
    groupId: 'g',
    relativePath: null,
    ...overrides
  } as OpenTabSearchResult
}

const newFileOption: TabEntryOption = {
  id: 'new-file:add tab',
  classification: { kind: 'new-file', relativePath: 'add tab' }
}

const existingFileOption = (relativePath: string): TabEntryOption => ({
  id: `existing-file:${relativePath}`,
  classification: { kind: 'existing-file', matchKind: 'fuzzy', relativePath }
})

let container: HTMLDivElement
let root: Root

function mount(node: React.JSX.Element): void {
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>)
  })
}

function pressKey(target: Element, key: string): void {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
}

function queryInput(): HTMLInputElement {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('input not found')
  }
  return input
}

function setQuery(value: string): void {
  const input = queryInput()
  // Why: React patches the input value setter to track changes; bypass it with
  // the native setter so the synthetic onChange actually fires.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
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

function renderEntry(props: Record<string, unknown> = {}): void {
  mount(
    <TabBarCreateEntry
      worktreeId="wt"
      groupId="g"
      menuOpen
      onOpenEntry={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  entryOptionsMock.options = []
  tabSearchMock.hold = false
  tabSearchMock.resultsByQuery = {}
  activationMocks.workspace.mockReturnValue({ status: 'activated' })
  activationMocks.browser.mockReturnValue({
    status: 'activated',
    pageId: 'page-1',
    focusTarget: 'webview'
  })
  activationMocks.simulator.mockReturnValue({ status: 'activated', tabId: 'tab-9' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TabBarCreateEntry tab results', () => {
  it('puts the matching tab first and still offers to create the file (AE1)', () => {
    entryOptionsMock.options = [newFileOption]
    tabSearchMock.resultsByQuery['add tab'] = [terminalResult()]
    renderEntry()

    setQuery('add tab')

    const rows = rowTexts()
    expect(rows[0]).toContain('Switch to tab')
    expect(rows[0]).toContain('Add tab search and jump in worktree')
    expect(rows.at(-1)).toContain('Create file')
    expect(rows.at(-1)).toContain('add tab')
  })

  it('shows the matched text rather than the shared label when tabs share a title (AE2)', () => {
    tabSearchMock.resultsByQuery['fix the flaky'] = [
      terminalResult({ title: 'Claude Code', matchedText: 'fix the flaky retry test' }),
      terminalResult({ id: 'open-tab:workspace:tab-2', tabId: 'tab-2', title: 'Claude Code' })
    ]
    renderEntry()

    setQuery('fix the flaky')

    expect(rowTexts()[0]).toContain('fix the flaky retry test')
    // The unmatched sibling falls back to its own title.
    expect(rowTexts()[1]).toContain('Claude Code')
  })

  it('orders tab rows above menu actions, agents and file entries', () => {
    entryOptionsMock.options = [existingFileOption('src/gem.ts')]
    tabSearchMock.resultsByQuery['gem'] = [terminalResult({ title: 'gem tab' })]
    const menuOptions: TabCreateMenuOption[] = [
      { id: 'new-browser', kind: 'new-browser', keywords: ['gem'], label: 'New Browser Tab' }
    ]
    const agentOptions: TabAgentLaunchOption[] = [
      { agent: 'gemini', aliases: ['gemini'], label: 'Gemini' }
    ]
    renderEntry({ agentOptions, menuOptions })

    setQuery('gem')

    const rows = rowTexts()
    expect(rows[0]).toContain('Switch to tab')
    expect(rows[1]).toContain('New Browser Tab')
    expect(rows[2]).toContain('Launch agent')
    expect(rows[3]).toContain('Open file')
  })

  it('keeps Enter on the row the user saw when a tab row arrives a render later', () => {
    entryOptionsMock.options = [newFileOption]
    tabSearchMock.resultsByQuery['add tab'] = [terminalResult()]
    tabSearchMock.hold = true
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onOpenEntry })

    setQuery('add tab')
    expect(rowTexts()).toHaveLength(1)

    tabSearchMock.hold = false
    renderEntry({ onOpenEntry })
    expect(rowTexts()[0]).toContain('Switch to tab')
    submitForm()

    expect(onOpenEntry).toHaveBeenCalledTimes(1)
    expect(activationMocks.workspace).not.toHaveBeenCalled()
  })

  it('activates a clicked tab row and closes the menu', () => {
    tabSearchMock.resultsByQuery['add tab'] = [terminalResult()]
    const onDidOpenEntry = vi.fn()
    renderEntry({ onDidOpenEntry })

    setQuery('add tab')
    act(() => {
      container.querySelector<HTMLButtonElement>('[role="option"]')?.click()
    })

    expect(activationMocks.workspace).toHaveBeenCalledTimes(1)
    expect(onDidOpenEntry).toHaveBeenCalledTimes(1)
  })

  it('queues the terminal surface focus handoff before the menu closes', () => {
    tabSearchMock.resultsByQuery['add tab'] = [terminalResult()]
    const onQueueSwitchFocus = vi.fn()
    const onDidOpenEntry = vi.fn()
    renderEntry({ onDidOpenEntry, onQueueSwitchFocus })

    setQuery('add tab')
    submitForm()

    expect(onQueueSwitchFocus).toHaveBeenCalledTimes(1)
    expect(onQueueSwitchFocus.mock.invocationCallOrder[0]).toBeLessThan(
      onDidOpenEntry.mock.invocationCallOrder[0]
    )
    // Focus only lands once the queued handoff runs, after the menu is gone.
    expect(activationMocks.focusTerminalTabSurface).not.toHaveBeenCalled()
    onQueueSwitchFocus.mock.calls[0][0]()
    expect(activationMocks.focusTerminalTabSurface).toHaveBeenCalledWith('term-1')
  })

  it('keeps the menu and every row usable when the activation fails', () => {
    entryOptionsMock.options = [newFileOption]
    activationMocks.workspace.mockReturnValue({ status: 'failed', reason: 'missing-tab' })
    tabSearchMock.resultsByQuery['add tab'] = [
      terminalResult(),
      terminalResult({ id: 'open-tab:workspace:tab-2', tabId: 'tab-2', title: 'second tab' })
    ]
    const onDidOpenEntry = vi.fn()
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    renderEntry({ onDidOpenEntry, onOpenEntry })

    setQuery('add tab')
    submitForm()

    expect(onDidOpenEntry).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Tab no longer exists')
    expect(rowTexts()).toHaveLength(3)

    // The other tab row and the create row below it still act.
    pressKey(queryInput(), 'ArrowDown')
    submitForm()
    expect(activationMocks.workspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabId: 'tab-2' })
    )
    pressKey(queryInput(), 'ArrowDown')
    submitForm()
    expect(onOpenEntry).toHaveBeenCalledTimes(1)
  })
})
