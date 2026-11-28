import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from './floating-browser-link.test-fixture'
import type { BrowserLinkTestStore } from './floating-browser-link.test-fixture'
import {
  openWorkspaceBrowserTab,
  openWorkspaceBrowserTabForLink
} from '../workspace/workspace-browser-tab-open'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/input/browser-focus'

import {
  openOwnedHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from './http-link-routing'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { activateBrowserPagePaletteResult } from '../palette/browser-page-palette-activation'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'
import { completePlacedBrowserLink } from '../workspace/placed-browser-link-completion'
import { beginPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/input/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
let store: BrowserLinkTestStore

beforeEach(() => {
  vi.stubGlobal('window', { api: {} })
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
})

function browser(groupId: string, url = URL_TO_OPEN) {
  return store.getState().createBrowserTab(WORKSPACE, url, {
    targetGroupId: groupId,
    executionHostId: 'local',
    browserRuntimeEnvironmentId: null,
    sessionProfileId: null,
    activate: false
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('floating link review regressions', () => {
  beforeEach(() => {
    store.setState({
      settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: true
    })
  })

  it('keeps the source repo profile when routing a local HTTP link into floating', async () => {
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, browserProfileId: 'source-profile' }))
    }))
    registerHttpLinkStoreAccessor(() => store.getState())
    registerWorkspaceHttpLinkBrowserOpener(openWorkspaceBrowserTab)
    try {
      await new Promise<void>((resolve) => {
        openOwnedHttpLink(URL_TO_OPEN, {
          worktreeId: WORKSPACE,
          sourceOwner: { kind: 'local' },
          floatingWorkspace: true,
          forceInApp: true,
          onBrowserOpenComplete: () => resolve()
        })
      })
      const opened = Object.values(store.getState().browserTabsByWorktree)
        .flat()
        .find((tab) => tab.url === URL_TO_OPEN)
      expect(opened).toMatchObject({
        worktreeId: 'repo1::/repo',
        sessionProfileId: 'source-profile'
      })
    } finally {
      registerWorkspaceHttpLinkBrowserOpener(null)
    }
  })

  it('retains a placed browser when reconciling the floating workspace', () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const created = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    store.getState().reconcileWorktreeTabModel(floating)
    expect(store.getState().unifiedTabsByWorktree[floating]).toEqual([
      expect.objectContaining({ entityId: created.id, contentType: 'browser' })
    ])
  })

  it('keeps the floating selection when a delayed link has lost foreground intent', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://existing.example/', {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null
    })
    const outcome = await openWorkspaceBrowserTabForLink({
      workspaceId: WORKSPACE,
      placementWorkspaceId: floating,
      url: URL_TO_OPEN,
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, canReveal: () => false }
    })
    expect(outcome).toMatchObject({ status: 'opened' })
    expect(store.getState().activeBrowserTabIdByWorktree[floating]).toBe(existing.id)
  })

  it('blocks floating palette activation before changing selection on a web client', () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://existing.example/', {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null
    })
    const target = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    vi.stubGlobal('window', { ...window, __ORCA_WEB_CLIENT__: true })
    expect(
      activateBrowserPagePaletteResult({
        worktreeId: floating,
        workspaceId: target.id,
        pageId: target.activePageId!,
        executionHostId: 'local'
      })
    ).toEqual({ status: 'blocked' })
    expect(store.getState().activeBrowserTabIdByWorktree[floating]).toBe(existing.id)
  })

  it('refuses a floating file before creating a hidden document on a web client', () => {
    vi.stubGlobal('window', { ...window, __ORCA_WEB_CLIENT__: true })
    expect(
      openLinkedFileInEditor(
        {
          filePath: '/repo/report.md',
          relativePath: 'report.md',
          worktreeId: WORKSPACE
        },
        null,
        { line: null, column: null },
        () => true,
        'local'
      )
    ).toBeNull()
    expect(store.getState().openFiles).toEqual([])
  })

  it('selects the source terminal after closing its last local browser while a floating browser survives', () => {
    const source = browser('a')
    store.getState().createBrowserTab(WORKSPACE, 'https://floating.example/', {
      placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    store.getState().setActiveBrowserTab(source.id, WORKSPACE)
    store.getState().closeBrowserTab(source.id)
    expect(store.getState().activeBrowserTabIdByWorktree[WORKSPACE]).toBeNull()
    expect(store.getState().activeTabTypeByWorktree[WORKSPACE]).toBe('terminal')
  })

  it('waits for a pending floating browser before looking up its page', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const created = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    const pages = store.getState().browserPagesByWorkspace[created.id]!
    const settle = beginPendingTab('pending-floating', floating, created.id, { kind: 'open' })
    store.setState({ browserPagesByWorkspace: {} })
    let outcome: unknown
    const opening = completePlacedBrowserLink(
      {
        workspaceId: WORKSPACE,
        placementWorkspaceId: floating,
        url: URL_TO_OPEN,
        intent: { kind: 'url' },
        focusOnCreate: false,
        onLinkOutcome: (result) => {
          outcome = result
        }
      },
      created.activePageId!,
      null,
      created.id
    )
    store.setState({ browserPagesByWorkspace: { [created.id]: pages } })
    settle('pending-floating')
    await opening
    expect(outcome).toMatchObject({
      status: 'opened',
      result: { browserPageId: created.activePageId }
    })
  })
})
