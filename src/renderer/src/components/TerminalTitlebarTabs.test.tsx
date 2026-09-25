// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRow } from '../../../shared/client-hosted-browser-rows'
import {
  applyClientHostedBrowserRows,
  getClientHostedBrowserRows
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { TerminalTitlebarTabs } from './TerminalTitlebarTabs'
import type { TerminalController } from './use-terminal-controller'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  tabBarProps: [] as Record<string, unknown>[]
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('./tab-bar/TabBar', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.tabBarProps.push(props)
    return null
  }
}))

const WORKTREE_ID = 'repo-1::/repo/worktree'
const ROW: ClientHostedBrowserRow = {
  browserPageId: 'page-1',
  title: 'Client page',
  url: 'https://example.com'
} as ClientHostedBrowserRow

let titlebarTarget: HTMLElement
let container: HTMLElement

function renderTitlebarTabs(): void {
  const controller = {
    activeBrowserTabId: null,
    activeFileId: null,
    activeTabId: null,
    activeTabType: 'terminal',
    effectiveActiveLayout: null,
    expandedPaneByTabId: {},
    handleActivateBrowserTab: vi.fn(),
    handleActivateTab: vi.fn(),
    handleCloseAllFiles: vi.fn(),
    handleCloseBrowserTab: vi.fn(),
    handleCloseFile: vi.fn(),
    handleCloseOthers: vi.fn(),
    handleCloseTab: vi.fn(),
    handleCloseTabsToLeft: vi.fn(),
    handleCloseTabsToRight: vi.fn(),
    handleDuplicateBrowserTab: vi.fn(),
    handleNewBrowserTab: vi.fn(),
    handleNewFile: vi.fn(),
    handleNewSimulatorTab: vi.fn(),
    handleNewTab: vi.fn(),
    handleOpenEntry: vi.fn(),
    handleTogglePaneExpand: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    mobileEmulatorEnabled: false,
    pinFile: vi.fn(),
    renderedActiveWorktreeId: WORKTREE_ID,
    setActiveFile: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabColor: vi.fn(),
    setTabCustomTitle: vi.fn(),
    tabBarOrder: [],
    titlebarTabsTarget: titlebarTarget,
    worktreeBrowserTabs: [],
    // Mirrors the projection hook's derivation so the assertion follows the real row store.
    worktreeClientHostedBrowserRows: getClientHostedBrowserRows(WORKTREE_ID),
    worktreeFiles: []
  } as unknown as TerminalController
  const root = createRoot(container)
  act(() => root.render(<TerminalTitlebarTabs controller={controller} />))
  act(() => root.unmount())
}

describe('TerminalTitlebarTabs', () => {
  beforeEach(() => {
    mocks.tabBarProps = []
    mocks.state = { tabsByWorktree: {}, unifiedTabsByWorktree: {}, getActiveTab: () => null }
    titlebarTarget = document.createElement('div')
    container = document.createElement('div')
    document.body.append(titlebarTarget, container)
  })

  afterEach(() => {
    applyClientHostedBrowserRows({ worktreeId: WORKTREE_ID, rows: [] })
    titlebarTarget.remove()
    container.remove()
  })

  it('forwards client-hosted browser rows to the titlebar tab bar', () => {
    applyClientHostedBrowserRows({ worktreeId: WORKTREE_ID, rows: [ROW] })
    renderTitlebarTabs()
    expect(mocks.tabBarProps.at(-1)?.clientHostedBrowserRows).toEqual([ROW])
  })

  it('passes no rows when the worktree has none', () => {
    renderTitlebarTabs()
    expect(mocks.tabBarProps.at(-1)?.clientHostedBrowserRows).toEqual([])
  })
})
