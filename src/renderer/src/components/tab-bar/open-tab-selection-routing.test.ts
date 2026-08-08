// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTabSearchResult } from './open-tab-search'

const mocks = vi.hoisted(() => ({
  activateWorkspaceTab: vi.fn(),
  activateBrowserPage: vi.fn(),
  activateSimulatorTab: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  queueBrowserFocusRequest: vi.fn()
}))

vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: mocks.activateWorkspaceTab
}))
vi.mock('@/lib/browser-page-palette-activation', () => ({
  activateBrowserPagePaletteResult: mocks.activateBrowserPage
}))
vi.mock('@/lib/simulator-tab-palette-activation', () => ({
  activateSimulatorTabPaletteResult: mocks.activateSimulatorTab
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/components/browser-pane/browser-focus', () => ({
  ORCA_BROWSER_FOCUS_REQUEST_EVENT: 'orca:browser-focus-request',
  queueBrowserFocusRequest: mocks.queueBrowserFocusRequest
}))

import { activateOpenTabSearchResult } from './open-tab-selection-routing'

const terminalResult: OpenTabSearchResult = {
  source: 'workspace',
  id: 'open-tab:workspace:tab-1',
  title: 'Claude Code',
  matchedText: null,
  worktreeId: 'wt-1',
  contentType: 'terminal',
  tabId: 'tab-1',
  entityId: 'term-1',
  groupId: 'group-2',
  relativePath: null
}

const editorResult: OpenTabSearchResult = {
  ...terminalResult,
  id: 'open-tab:workspace:tab-2',
  contentType: 'editor',
  tabId: 'tab-2',
  entityId: 'file-2',
  relativePath: 'src/zebra.ts'
}

const browserResult: OpenTabSearchResult = {
  source: 'browser',
  id: 'open-tab:browser:page-1',
  title: 'Project Docs',
  matchedText: null,
  worktreeId: 'wt-1',
  contentType: 'browser',
  pageId: 'page-1',
  workspaceId: 'ws-1'
}

const simulatorResult: OpenTabSearchResult = {
  source: 'simulator',
  id: 'open-tab:simulator:tab-3',
  title: 'iPhone 15',
  matchedText: null,
  worktreeId: 'wt-1',
  contentType: 'simulator',
  tabId: 'tab-3',
  groupId: 'group-2'
}

describe('activateOpenTabSearchResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateWorkspaceTab.mockReturnValue({ status: 'activated' })
    mocks.activateBrowserPage.mockReturnValue({
      status: 'activated',
      pageId: 'page-1',
      focusTarget: 'address-bar'
    })
    mocks.activateSimulatorTab.mockReturnValue({ status: 'activated', tabId: 'tab-3' })
  })

  it('activates a workspace tab by its identifiers and focuses the terminal surface', () => {
    const outcome = activateOpenTabSearchResult(terminalResult)

    expect(mocks.activateWorkspaceTab).toHaveBeenCalledWith({
      contentType: 'terminal',
      entityId: 'term-1',
      groupId: 'group-2',
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    })
    expect(outcome).toMatchObject({ status: 'activated' })

    if (outcome.status !== 'activated') {
      throw new Error('expected activation')
    }
    outcome.focus?.()
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('term-1')
  })

  it('queues no focus handoff for an editor tab, which focuses itself', () => {
    expect(activateOpenTabSearchResult(editorResult)).toEqual({ status: 'activated', focus: null })
  })

  it('carries the activation focus target into the browser focus request', () => {
    const outcome = activateOpenTabSearchResult(browserResult)
    expect(mocks.activateBrowserPage).toHaveBeenCalledWith({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1'
    })

    const events: CustomEvent[] = []
    const onFocusRequest = (event: Event): void => {
      events.push(event as CustomEvent)
    }
    window.addEventListener('orca:browser-focus-request', onFocusRequest)
    if (outcome.status !== 'activated') {
      throw new Error('expected activation')
    }
    outcome.focus?.()
    window.removeEventListener('orca:browser-focus-request', onFocusRequest)

    const detail = { pageId: 'page-1', target: 'address-bar' }
    expect(mocks.queueBrowserFocusRequest).toHaveBeenCalledWith(detail)
    expect(events[0]?.detail).toEqual(detail)
  })

  it('focuses the simulator tab the activation reports', () => {
    const outcome = activateOpenTabSearchResult(simulatorResult)

    if (outcome.status !== 'activated') {
      throw new Error('expected activation')
    }
    outcome.focus?.()
    expect(mocks.activateSimulatorTab).toHaveBeenCalledWith({ tabId: 'tab-3', worktreeId: 'wt-1' })
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-3')
  })

  it('reports a stale target per source', () => {
    mocks.activateWorkspaceTab.mockReturnValue({ status: 'failed', reason: 'missing-tab' })
    expect(activateOpenTabSearchResult(terminalResult)).toEqual({
      status: 'failed',
      message: 'Tab no longer exists'
    })

    mocks.activateBrowserPage.mockReturnValue({ status: 'failed', reason: 'missing-page' })
    expect(activateOpenTabSearchResult(browserResult)).toEqual({
      status: 'failed',
      message: 'Browser page no longer exists'
    })

    mocks.activateSimulatorTab.mockReturnValue({ status: 'failed', reason: 'missing-tab' })
    expect(activateOpenTabSearchResult(simulatorResult)).toEqual({
      status: 'failed',
      message: 'Mobile emulator tab no longer exists'
    })
  })

  it('reports a missing worktree distinguishably from a stale tab', () => {
    mocks.activateWorkspaceTab.mockReturnValue({ status: 'failed', reason: 'missing-worktree' })
    mocks.activateSimulatorTab.mockReturnValue({ status: 'failed', reason: 'missing-worktree' })

    expect(activateOpenTabSearchResult(terminalResult)).toEqual({
      status: 'failed',
      message: 'Workspace no longer exists'
    })
    expect(activateOpenTabSearchResult(simulatorResult)).toEqual({
      status: 'failed',
      message: 'Workspace no longer exists'
    })
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
