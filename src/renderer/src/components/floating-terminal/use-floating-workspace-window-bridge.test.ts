// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { listenForHibernatedAgentWake } from '@/components/terminal-pane/mounting/hibernated-agent-wake-listener'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import {
  setTabShownOutsidePane,
  takeSleepingAgentWakeRequest
} from '@/lib/agent-session/resume/sleeping-agent-wake-requests'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { startFloatingWorkspaceWindowBridge } from './use-floating-workspace-window-bridge'

const initialAppState = useAppStore.getInitialState()
const popoutSettings = {
  ...getDefaultSettings('/test'),
  floatingTerminalEnabled: true,
  experimentalFloatingWorkspacePopout: true,
  experimentalFloatingWorkspaceMode: 'popout' as const
}

function stubWindowApi() {
  const handlers = new Map<string, () => void>()
  const on = (name: string) => (callback: () => void) => {
    handlers.set(name, callback)
    return () => handlers.delete(name)
  }
  const api = {
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    publishSnapshot: vi.fn(),
    onSnapshotRequested: on('snapshotRequested'),
    onDockRequested: on('dock'),
    onHiddenByUser: on('hiddenByUser'),
    onAgentAcked: on('agentAcked')
  }
  vi.stubGlobal('api', { floatingWorkspaceWindow: api, dashboard: {} })
  return { api, handlers }
}

const FLOATING_GROUP_ID = 'floating-group'
const wakes = { shown: vi.fn(() => 'claim-shown'), other: vi.fn(() => 'claim-other') }
let stopWakeListeners: (() => void)[] = []

/** Two floating terminal tabs whose hidden panes already armed a held agent wake. */
function setUpTwoFloatingTabs(): void {
  const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
  useAppStore.setState({
    tabsByWorktree: {
      [worktreeId]: [
        makeTab({ id: 'tab-shown', worktreeId }),
        makeTab({ id: 'tab-other', worktreeId })
      ]
    },
    unifiedTabsByWorktree: {
      [worktreeId]: [
        makeUnifiedTab({ id: 'tab-shown', worktreeId, groupId: FLOATING_GROUP_ID }),
        makeUnifiedTab({ id: 'tab-other', worktreeId, groupId: FLOATING_GROUP_ID })
      ]
    },
    groupsByWorktree: {
      [worktreeId]: [
        makeTabGroup({
          id: FLOATING_GROUP_ID,
          worktreeId,
          activeTabId: 'tab-shown',
          tabOrder: ['tab-shown', 'tab-other']
        })
      ]
    },
    activeGroupIdByWorktree: { [worktreeId]: FLOATING_GROUP_ID }
  })
  stopWakeListeners = [
    listenForHibernatedAgentWake(worktreeId, 'tab-shown', () => [
      { dispose: () => undefined, wakeHibernatedAgentIfArmed: wakes.shown }
    ]),
    listenForHibernatedAgentWake(worktreeId, 'tab-other', () => [
      { dispose: () => undefined, wakeHibernatedAgentIfArmed: wakes.other }
    ])
  ]
}

function showFloatingTab(tabId: string): void {
  useAppStore.setState((s) => ({
    groupsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: (
        s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
      ).map((group) => ({ ...group, activeTabId: tabId }))
    }
  }))
}

beforeEach(() => {
  useAppStore.setState({
    ...initialAppState,
    settings: popoutSettings,
    floatingWorkspacePanelOpen: true,
    updateSettings: vi.fn(async (updates: Partial<GlobalSettings>) => {
      useAppStore.setState((s) => ({ settings: { ...popoutSettings, ...s.settings, ...updates } }))
    })
  })
})

afterEach(() => {
  for (const unlisten of stopWakeListeners) {
    unlisten()
  }
  stopWakeListeners = []
  setTabShownOutsidePane(FLOATING_TERMINAL_WORKTREE_ID, null)
  wakes.shown.mockClear()
  wakes.other.mockClear()
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppState, true)
})

describe('Floating Workspace window bridge', () => {
  it('dock opens the in-window panel and requests destroy only after the in-window pane has fit', async () => {
    const { api, handlers } = stubWindowApi()
    useAppStore.setState({ floatingWorkspacePanelOpen: false })
    let paneFit: () => void = () => undefined
    const stop = startFloatingWorkspaceWindowBridge(
      () => new Promise((resolve) => (paneFit = resolve))
    )
    useAppStore.setState({ floatingWorkspacePanelOpen: true })
    expect(api.show).toHaveBeenCalledWith({ focus: true })

    handlers.get('dock')?.()
    await vi.waitFor(() => expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(true))
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings?.experimentalFloatingWorkspaceMode).toBe('in-window')
    )
    expect(api.destroy).not.toHaveBeenCalled()
    paneFit()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    stop()
  })

  it('returning to Pop-out during the dock fit wait keeps the reshown window', async () => {
    const { api, handlers } = stubWindowApi()
    let paneFit: () => void = () => undefined
    let fit: Promise<void> = Promise.resolve()
    const stop = startFloatingWorkspaceWindowBridge(
      () => (fit = new Promise((resolve) => (paneFit = resolve)))
    )
    handlers.get('dock')?.()
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings?.experimentalFloatingWorkspaceMode).toBe('in-window')
    )
    await useAppStore.getState().updateSettings({ experimentalFloatingWorkspaceMode: 'popout' })
    expect(api.show).toHaveBeenCalledTimes(2)
    paneFit()
    await fit
    expect(api.destroy).not.toHaveBeenCalled()
    stop()
  })

  it('leaving Pop-out while the window is hidden destroys it without opening the panel', async () => {
    const { api, handlers } = stubWindowApi()
    const waitForFit = vi.fn(async () => undefined)
    const stop = startFloatingWorkspaceWindowBridge(waitForFit)
    handlers.get('hiddenByUser')?.()
    handlers.get('dock')?.()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(false)
    expect(waitForFit).not.toHaveBeenCalled()
    stop()
  })

  it('a bridge that starts in-window destroys a window a crashed renderer left mid-dock', async () => {
    const { api } = stubWindowApi()
    useAppStore.setState({
      settings: { ...popoutSettings, experimentalFloatingWorkspaceMode: 'in-window' }
    })
    const stop = startFloatingWorkspaceWindowBridge()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    expect(api.show).not.toHaveBeenCalled()
    stop()
  })

  it("a restored pop-out wakes the shown tab's held agent with the in-window panel still closed", async () => {
    stubWindowApi()
    setUpTwoFloatingTabs()
    const stop = startFloatingWorkspaceWindowBridge()
    await Promise.resolve()

    expect(wakes.shown).toHaveBeenCalledTimes(1)
    expect(wakes.other).not.toHaveBeenCalled()
    stop()
  })

  it('switching the shown tab wakes the new tab, and a return wakes the first again', async () => {
    stubWindowApi()
    setUpTwoFloatingTabs()
    const stop = startFloatingWorkspaceWindowBridge()
    await Promise.resolve()

    showFloatingTab('tab-other')
    await vi.waitFor(() => expect(wakes.other).toHaveBeenCalledTimes(1))
    showFloatingTab('tab-shown')
    await vi.waitFor(() => expect(wakes.shown).toHaveBeenCalledTimes(2))
    stop()
  })

  it('a reveal and a tab switch in one task wake only the tab left showing', async () => {
    stubWindowApi()
    setUpTwoFloatingTabs()
    useAppStore.setState({ floatingWorkspacePanelOpen: false })
    const stop = startFloatingWorkspaceWindowBridge()

    useAppStore.setState({ floatingWorkspacePanelOpen: true })
    showFloatingTab('tab-other')
    await Promise.resolve()

    expect(wakes.other).toHaveBeenCalledTimes(1)
    expect(wakes.shown).not.toHaveBeenCalled()
    stop()
  })

  it('a pane that connects while its tab is shown starts its agent; after a hide it holds', async () => {
    const { handlers } = stubWindowApi()
    setUpTwoFloatingTabs()
    const record = (tabId: string): SleepingAgentSessionRecord =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake check reads only worktreeId, tabId and paneKey.
      ({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID, tabId, paneKey: `${tabId}:leaf` }) as never
    const stop = startFloatingWorkspaceWindowBridge()
    await Promise.resolve()

    expect(takeSleepingAgentWakeRequest(record('tab-shown'))).toBe(true)
    expect(takeSleepingAgentWakeRequest(record('tab-other'))).toBe(false)
    handlers.get('hiddenByUser')?.()
    expect(takeSleepingAgentWakeRequest(record('tab-shown'))).toBe(false)
    stop()
  })

  it('a user hide closes the open flag without hiding the window a second time', () => {
    const { api, handlers } = stubWindowApi()
    const stop = startFloatingWorkspaceWindowBridge()
    expect(api.show).toHaveBeenCalledWith({ focus: false })
    handlers.get('hiddenByUser')?.()
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(false)
    expect(api.hide).not.toHaveBeenCalled()
    stop()
  })
})
