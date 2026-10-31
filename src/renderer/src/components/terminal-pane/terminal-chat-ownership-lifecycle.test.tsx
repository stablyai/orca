// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { makeGroup, makeTerminalTab, makeUnifiedTab } from '../worktree-jump-palette-test-fixtures'
import { selectNativeChatWslProject } from './terminal-pane-host-state'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useTerminalPaneProjection } from './use-terminal-pane-projection'
import { sendCapturedTerminalInput } from './terminal-captured-input-dispatch'
import {
  captureTerminalPaneRecoveryGeneration,
  _resetTerminalPaneRecoveryForTests,
  registerTerminalPaneRecoveryInstance,
  settleTerminalPaneRecovery,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'
import { canRemountTerminalPaneWithoutChatOwner } from './terminal-pane-recovery-ownership'
import { registerRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  createRemountTerminalTabForRecovery,
  createSettleTerminalTabRecovery
} from '@/store/slices/worktrees/session/worktree-slice-lookups'
import { resolveActiveNativeChatSplitTarget } from '../native-chat/native-chat-layout-actions'
import type { PtyTransport } from './pty-transport-types'
import { createTabsLabelActions } from '../../store/slices/tabs/tabs-label-actions'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import type { RemotePaneLayoutPusher } from './remote-pane-layout-push'
import type * as TabsHostMirroring from '../../store/slices/tabs/tabs-host-mirroring'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const mocks = vi.hoisted(() => {
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
  const settings: { nativeChatProviders?: Record<string, boolean> } = {}
  const tab = { id: 'tab', entityId: 'tab', contentType: 'terminal', viewMode: 'chat' }
  const state = {
    terminalLayoutsByTabId: layouts,
    unifiedTabsByWorktree: { wt: [tab] },
    tabsByWorktree: {},
    settings,
    pendingPaneAccountRestarts: [],
    runtimePaneTitlesByTabId: { tab: { 1: 'codex', 2: 'codex' } },
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    setTabLayout: (id: string, layout: TerminalLayoutSnapshot | null) => {
      if (layout) {
        layouts[id] = layout
      } else {
        delete layouts[id]
      }
    },
    setTabViewMode: (_id: string, mode: 'terminal' | 'chat') => {
      state.unifiedTabsByWorktree = { wt: [{ ...tab, viewMode: mode }] }
    },
    toggleTabViewMode: (id: string): void => {
      state.setTabViewMode(
        id,
        state.unifiedTabsByWorktree.wt[0].viewMode === 'chat' ? 'terminal' : 'chat'
      )
    }
  }
  return { state }
})
vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const { terminalLayoutEqual } = await import('../../../../shared/terminal-layout-equality')
  mocks.state.setTabLayout = (id, layout) => {
    const previous = mocks.state.terminalLayoutsByTabId
    if (layout ? terminalLayoutEqual(previous[id], layout) : !(id in previous)) {
      return
    }
    const next = { ...previous }
    if (layout) {
      next[id] = layout
    } else {
      delete next[id]
    }
    mocks.state.terminalLayoutsByTabId = next
    useAppStore.setState({ terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId })
  }
  mocks.state.setTabViewMode = (_id, mode) => {
    mocks.state.unifiedTabsByWorktree = {
      wt: [{ ...useAppStore.getState().unifiedTabsByWorktree.wt[0], viewMode: mode }]
    }
    useAppStore.setState({ unifiedTabsByWorktree: mocks.state.unifiedTabsByWorktree })
  }
  const useAppStore = create(() => mocks.state)
  return { useAppStore }
})
vi.mock('@/store/terminals/tab-change-through-layout-owner', () => ({
  sendTabChangeToLayoutOwner: () => false
}))
vi.mock('@/store/slices/tabs/tabs-host-mirroring', async (original) => ({
  ...(await original<typeof TabsHostMirroring>()),
  mirrorTabViewModeToHost: vi.fn()
}))
vi.mock('@/runtime/web-runtime-terminal-buffer-actions', () => ({
  clearWebRuntimeTerminalBuffer: vi.fn()
}))

function makeFixture(
  paneIds = [1, 2],
  remotePusher?: RemotePaneLayoutPusher,
  isWslProject: boolean | null = true
) {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  const panes = [LEFT, RIGHT].map((leafId, index) => {
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = String(paneIds[index])
    element.dataset.leafId = leafId
    split.append(element)
    return {
      id: paneIds[index],
      leafId,
      container: element,
      serializeAddon: { serialize: () => 'retained scrollback' }
    }
  })
  const manager = {
    getPanes: () => panes,
    getActivePane: (): (typeof panes)[number] | undefined => panes[0],
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  return {
    managerRef: { current: manager },
    containerRef: { current: container },
    nativeChatIsWslProject: isWslProject,
    nativeChatTranscriptIsLocalReadable: true,
    onAgentExitedRef: { current: vi.fn() },
    paneCount: 2,
    tabId: 'tab',
    worktreeId: 'wt',
    tabWideAgentHintLeafId: null,
    setTabWideAgentHintLeafId: vi.fn(),
    clearedScrollbackLeafIdsRef: { current: new Set<string>() },
    expandedPaneIdRef: { current: null },
    paneTitles: {},
    paneTitlesRef: { current: {} },
    paneTransportsRef: { current: new Map() },
    remotePaneLayoutPusherRef: { current: remotePusher ?? null },
    removedTitleLeafIdsRef: { current: new Set<string>() },
    setPaneTitles: vi.fn(),
    contextMenu: { open: false, menuPaneId: null },
    contextMenuLeafId: LEFT,
    getContextMenuLeafId: () => LEFT,
    isActive: true,
    isVisible: true,
    settings: null,
    shouldMeasureHiddenStartup: false,
    sshReconnectOwnsTerminalErrors: false,
    systemPrefersDark: false,
    terminalError: null,
    terminalErrorsByPaneId: {},
    setTerminalError: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn()
  }
}
function useFixture(fixture: ReturnType<typeof makeFixture>, initialOwner: string | null) {
  const [chatLeafId, setChatLeafId] = useState(initialOwner)
  const input = { ...fixture, chatLeafId, setChatLeafId }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every manager method and controller field exercised here.
  const controller = input as unknown as Parameters<typeof useTerminalPaneChatState>[0]
  const chat = useTerminalPaneChatState(controller)
  const layoutInput = { ...input, ...chat, setTabLayout: mocks.state.setTabLayout }
  const layout = useTerminalPaneLayoutPersistence(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the persistence hook.
    layoutInput as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
  )
  const projection = useTerminalPaneProjection(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every projection field; unrelated continuation paths have no provider session.
    layoutInput as unknown as Parameters<typeof useTerminalPaneProjection>[0]
  )
  return {
    ...chat,
    ...layout,
    ...projection,
    chatLeafId,
    setChatLeafId,
    manager: controller.managerRef.current
  }
}

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  useAppStore.setState(createTestStore().getState(), true)
  const actions = createTabsLabelActions(useAppStore.setState, useAppStore.getState)
  mocks.state.setTabViewMode = actions.setTabViewMode
  mocks.state.toggleTabViewMode = actions.toggleTabViewMode
  useAppStore.setState({
    ...actions,
    setTabLayout: mocks.state.setTabLayout,
    unifiedTabsByWorktree: {
      wt: [{ ...makeUnifiedTab('tab', 'wt', 'tab', 'codex'), viewMode: 'chat' }]
    },
    remountTerminalTabForRecovery: createRemountTerminalTabForRecovery(
      useAppStore.setState,
      useAppStore.getState
    ),
    settleTerminalTabRecovery: createSettleTerminalTabRecovery(
      useAppStore.setState,
      useAppStore.getState
    ),
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    tabsByWorktree: { wt: [{ ...makeTerminalTab('tab', 'wt', 'codex'), viewMode: 'chat' }] }
  })
  useAppStore.setState({
    settings: createGlobalSettingsFixture({
      ...useAppStore.getState().settings,
      nativeChatProviders: { claude: true, codex: true }
    }),
    runtimePaneTitlesByTabId: { tab: { 1: 'codex', 2: 'codex' } }
  })
  mocks.state.setTabViewMode('tab', 'chat')
  mocks.state.setTabLayout('tab', {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    activeLeafId: LEFT,
    expandedLeafId: null,
    chatLeafId: RIGHT
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('terminal chat ownership lifecycle', () => {
  it.each([
    { wake: 'identity', population: 10 },
    { wake: 'return', population: 100 }
  ] as const)(
    'heals pending intent at $population panes, then handles $wake',
    async ({ wake, population }) => {
      const fixture = makeFixture(undefined, undefined, null)
      useAppStore.setState({
        runtimePaneTitlesByTabId: { tab: {} },
        tabsByWorktree: {
          wt: [
            {
              ...useAppStore.getState().tabsByWorktree.wt[0],
              ptyId: 'same-pty',
              viewMode: wake === 'return' ? undefined : 'chat'
            }
          ]
        }
      })
      const saved = {
        ...mocks.state.terminalLayoutsByTabId.tab,
        ptyIdsByLeafId: { [LEFT]: 'same-pty' }
      }
      delete saved.chatLeafId
      mocks.state.setTabLayout('tab', saved)
      const hook = renderHook(() => useFixture(fixture, null))
      const manager = hook.result.current.manager
      if (!manager) {
        throw new Error('mounted manager missing')
      }
      let leafReads = 0
      let coverageReads = 0
      const basePane = manager.getPanes()[0]
      const panes = Array.from({ length: population }, (_, index) => {
        const leafId =
          index === 0
            ? LEFT
            : index === 1
              ? RIGHT
              : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        if (!isTerminalLeafId(leafId)) {
          throw new Error('invalid fixture leaf')
        }
        const container = document.createElement('div')
        return {
          ...basePane,
          id: index + 1,
          get container() {
            coverageReads += 1
            return container
          },
          get leafId() {
            leafReads += 1
            return leafId
          }
        }
      })
      vi.spyOn(manager, 'getPanes').mockReturnValue(panes)
      const requestLeafVisits: number[] = []
      const requestCoverageVisits: number[] = []
      const unregister = registerRuntimeTerminalTab({
        tabId: 'tab',
        worktreeId: 'wt',
        getManager: () => manager,
        getContainer: () => fixture.containerRef.current,
        getPtyIdForPane: () => 'same-pty',
        getTabWideAgentHintLeafId: () => null
      })
      const instance = registerTerminalPaneRecoveryInstance('tab', () => {
        const before = leafReads
        const beforeCoverage = coverageReads
        const allowed = canRemountTerminalPaneWithoutChatOwner('wt', 'tab', manager)
        requestLeafVisits.push(leafReads - before)
        requestCoverageVisits.push(coverageReads - beforeCoverage)
        return allowed
      })
      try {
        expect(hook.result.current.chatPane).toBeNull()
        expect(hook.result.current.chatLeafId).toBeNull()
        expect(hook.result.current.contextMenuCanToggleChat).toBe(true)
        expect(hook.result.current.contextMenuIsChatView).toBe(true)
        await act(async () => {
          expect(
            await requestTerminalPaneRecovery({
              tabId: 'tab',
              ptyId: 'same-pty',
              reason: 'restore-blocked',
              terminalRecoveryGeneration: 0,
              terminalRecoveryInstanceId: instance.id
            })
          ).toBe(true)
          settleTerminalPaneRecovery('tab', 1, 'success')
        })
        expect(requestLeafVisits).toEqual([2 * population + 2, 2 * population + 2])
        expect(requestCoverageVisits).toEqual([population, population])
        expect(useAppStore.getState().tabsByWorktree.wt[0]).toMatchObject({
          ptyId: 'same-pty',
          recovery: { generation: 1, outcome: 'success' }
        })
        expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
        expect(useAppStore.getState().terminalLayoutsByTabId.tab).toEqual(saved)
        expect(manager.getPanes()[0].serializeAddon.serialize()).toBe('retained scrollback')
        if (wake === 'return') {
          act(() => hook.result.current.handleContextMenuToggleNativeChat())
          fixture.nativeChatIsWslProject = true
        }
        act(() => useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'claude' } } }))
        expect(hook.result.current.chatPane).toBe(
          wake === 'identity' ? manager.getPanes()[0] : null
        )
        expect(useAppStore.getState().tabsByWorktree.wt[0].viewMode).toBe(
          wake === 'identity' ? 'chat' : 'terminal'
        )
        if (wake === 'return') {
          expect(hook.result.current.contextMenuCanToggleChat).toBe(true)
          act(() => hook.result.current.handleContextMenuToggleNativeChat())
          expect(hook.result.current.chatLeafId).toBe(LEFT)
        }
      } finally {
        instance.unregister()
        unregister()
      }
    }
  )

  it.each([
    'covered sibling',
    'saved sibling',
    'acquired identity',
    'acquired sibling',
    'disposed',
    'stale'
  ] as const)(
    'refuses a tab-wide remount for %s, including changes during authoritative liveness',
    async (change) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
      const fixture = makeFixture(undefined, undefined, null)
      useAppStore.setState({ runtimePaneTitlesByTabId: { tab: {} } })
      const saved = { ...mocks.state.terminalLayoutsByTabId.tab }
      if (change !== 'saved sibling') {
        delete saved.chatLeafId
      }
      mocks.state.setTabLayout('tab', saved)
      if (change === 'acquired sibling') {
        fixture.nativeChatIsWslProject = true
        mocks.state.setTabViewMode('tab', 'terminal')
      }
      const hook = renderHook(() => useFixture(fixture, saved.chatLeafId ?? null))
      const manager = hook.result.current.manager
      if (!manager) {
        throw new Error('mounted manager missing')
      }
      const unregister = registerRuntimeTerminalTab({
        tabId: 'tab',
        worktreeId: 'wt',
        getManager: () => manager,
        getContainer: () => fixture.containerRef.current,
        getPtyIdForPane: () => 'same-pty',
        getTabWideAgentHintLeafId: () => null
      })
      const instance = registerTerminalPaneRecoveryInstance('tab', () =>
        canRemountTerminalPaneWithoutChatOwner('wt', 'tab', manager)
      )
      const remount = vi.fn(useAppStore.getState().remountTerminalTabForRecovery)
      useAppStore.setState({ remountTerminalTabForRecovery: remount })
      let resolveProbe: (live: boolean) => void = () => {
        throw new Error('probe not started')
      }
      const hasPty = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveProbe = resolve
          })
      )
      vi.stubGlobal('window', { api: { pty: { hasPty } } })
      try {
        if (change === 'covered sibling') {
          const cover = document.createElement('div')
          cover.className = 'native-chat-pane-shell'
          manager.getPanes()[1].container.append(cover)
        }
        const pending = requestTerminalPaneRecovery({
          tabId: 'tab',
          ptyId: 'same-pty',
          reason: 'input-undeliverable',
          requireAuthoritativeLiveness: true,
          terminalRecoveryGeneration: 0,
          terminalRecoveryInstanceId: instance.id
        })
        if (change === 'acquired identity') {
          // Before React commits an owner/cover, the current supported leaf already owns the route.
          act(() => {
            useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'codex' } } })
            expect(canRemountTerminalPaneWithoutChatOwner('wt', 'tab', manager)).toBe(false)
          })
        } else if (change === 'acquired sibling') {
          // A user chooses an inactive sibling while the old terminal probe is outstanding.
          act(() => {
            useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 2: 'codex' } } })
          })
          act(() => {
            hook.result.current.toggleNativeChatForLeaf(RIGHT)
            expect(canRemountTerminalPaneWithoutChatOwner('wt', 'tab', manager)).toBe(false)
          })
          expect(useAppStore.getState().terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
        } else if (change === 'disposed') {
          instance.unregister()
        } else if (change === 'stale') {
          act(() => {
            createRemountTerminalTabForRecovery(useAppStore.setState, useAppStore.getState)('tab', {
              reason: 'write-stalled',
              trigger: 'automatic',
              generation: 0,
              now: Date.now()
            })
          })
        }
        const blockedAtStart = change === 'covered sibling' || change === 'saved sibling'
        if (!blockedAtStart) {
          resolveProbe(true)
        }
        expect(await pending).toBe(false)
        expect(hasPty).toHaveBeenCalledTimes(blockedAtStart ? 0 : 1)
        expect(remount).not.toHaveBeenCalled()
      } finally {
        instance.unregister()
        unregister()
        vi.unstubAllGlobals()
      }
    }
  )

  it('drives the pane menu from actual folder runtime facts through entry and retirement', () => {
    mocks.state.setTabViewMode('tab', 'terminal')
    const fixture = makeFixture()
    const folder = makeFolderWorkspace({
      id: 'folder',
      folderPath: 'C:/folder',
      executionHostId: 'local'
    })
    useAppStore.setState({
      projects: [],
      repos: [],
      projectGroups: [],
      folderWorkspaces: [folder],
      settings: createGlobalSettingsFixture({
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    })
    const hook = renderHook(() => {
      const runtime = useAppStore((state) => selectNativeChatWslProject(state, 'folder:folder'))
      return useFixture({ ...fixture, nativeChatIsWslProject: runtime }, null)
    })
    expect(hook.result.current.contextMenuCanToggleChat).toBe(false)
    act(() => useAppStore.setState({ folderWorkspaces: [] }))
    expect(hook.result.current.contextMenuCanToggleChat).toBe(false)
    act(() =>
      useAppStore.setState({
        folderWorkspaces: [{ ...folder, folderPath: '//wsl.localhost/Ubuntu/work' }]
      })
    )
    expect(hook.result.current.contextMenuCanToggleChat).toBe(true)
    act(() => hook.result.current.handleContextMenuToggleNativeChat())
    expect(hook.result.current.chatLeafId).toBe(LEFT)
    act(() => useAppStore.setState({ folderWorkspaces: [folder] }))
    expect(hook.result.current.effectiveChatViewMode).toBe(false)
    expect(useAppStore.getState().tabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it.each([true, false])(
    'recovers ownerless saved intent while unknown, then resolves runtime to %s',
    async (resolved) => {
      const fixture = makeFixture(undefined, undefined, null)
      const active = fixture.managerRef.current.getPanes()[0]
      const sendInput = vi.fn(() => true)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured dispatch reads only this transport's identity and input endpoint.
      const transport = { getPtyId: () => 'same-pty', sendInput } as unknown as PtyTransport
      fixture.paneTransportsRef.current.set(active.id, transport)

      fixture.managerRef.current.getActivePane = () => undefined
      const saved = { ...mocks.state.terminalLayoutsByTabId.tab }
      delete saved.chatLeafId
      mocks.state.setTabLayout('tab', saved)
      const writes = vi.fn(useAppStore.getState().setTabViewMode)
      const remount = vi.fn(() => ({ remounted: true, generation: 1 }) as const)
      useAppStore.setState({
        setTabViewMode: writes,
        getTab: () => useAppStore.getState().unifiedTabsByWorktree.wt[0],
        remountTerminalTabForRecovery: remount,
        groupsByWorktree: { wt: [makeGroup('wt', ['tab'])] },
        unifiedTabsByWorktree: {
          wt: [{ ...useAppStore.getState().unifiedTabsByWorktree.wt[0], groupId: 'group-wt' }]
        }
      })
      const hook = renderHook(() => useFixture(fixture, null))
      expect(hook.result.current.chatPane).toBeNull()
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
      fixture.managerRef.current.getActivePane = () => active
      hook.rerender()
      expect(hook.result.current.chatLeafId).toBe(LEFT)
      expect(hook.result.current.chatPane).toBe(active)
      expect(writes).not.toHaveBeenCalled()
      fixture.nativeChatIsWslProject = resolved
      hook.rerender()
      expect(hook.result.current.effectiveChatViewMode).toBe(resolved)
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe(
        resolved ? 'chat' : 'terminal'
      )
      expect(useAppStore.getState().tabsByWorktree.wt[0].viewMode).toBe(
        resolved ? 'chat' : 'terminal'
      )
      expect(fixture.managerRef.current.getPanes()[0]).toBe(active)
      expect(active.serializeAddon.serialize()).toBe('retained scrollback')
      expect(captureTerminalPaneRecoveryGeneration('tab')).toBe(0)
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab',
          ptyId: 'same-pty',
          reason: 'reattach-unverifiable'
        })
      ).toBe(!resolved)
      expect(remount).toHaveBeenCalledTimes(resolved ? 0 : 1)
      expect(resolveActiveNativeChatSplitTarget(useAppStore.getState(), 'wt', 'group-wt')).toEqual(
        resolved ? { kind: 'terminal-pane', terminalTabId: 'tab' } : null
      )
      expect(
        sendCapturedTerminalInput({
          targetPaneMounted: fixture.managerRef.current.getPanes().includes(active),
          currentTransport: fixture.paneTransportsRef.current.get(active.id),
          capturedTransport: transport,
          capturedPtyId: 'same-pty',
          data: 'next prompt\r'
        })
      ).toBe(true)
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('next prompt\r', 'driving')
      act(() => mocks.state.setTabViewMode('tab', 'chat'))
      expect(hook.result.current.effectiveChatViewMode).toBe(resolved)
    }
  )

  it.each(['openclaude', 'zcode'] as const)(
    'retires an ownerless saved %s once late identity arrives',
    (agent) => {
      const fixture = makeFixture(undefined, undefined, null)
      useAppStore.setState({ runtimePaneTitlesByTabId: { tab: {} } })
      const hook = renderHook(() => useFixture(fixture, null))
      expect(hook.result.current.chatPane).toBeNull()
      act(() =>
        useAppStore.setState({
          paneForegroundAgentByPaneKey: {
            [`tab:${LEFT}`]: { agent, shellForeground: false, routingRevoked: false }
          }
        })
      )
      expect(hook.result.current.effectiveChatViewMode).toBe(false)
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    }
  )

  it('preserves a saved view through unknown runtime until non-WSL is confirmed', () => {
    const fixture = makeFixture(undefined, undefined, null)
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    expect(hook.result.current.effectiveChatViewMode).toBe(true)
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    fixture.nativeChatIsWslProject = false
    hook.rerender()
    expect(hook.result.current.effectiveChatViewMode).toBe(false)
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it.each([
    { isWsl: false, agent: 'codex' },
    { isWsl: true, agent: 'openclaude' },
    { isWsl: true, agent: 'zcode' }
  ] as const)(
    'returns saved and mounted $agent chat panes to terminal (WSL: $isWsl)',
    ({ isWsl, agent }) => {
      const fixture = makeFixture()
      fixture.nativeChatIsWslProject = isWsl
      useAppStore.setState({
        agentStatusByPaneKey: {
          [`tab:${RIGHT}`]: {
            agentType: agent,
            state: 'waiting',
            prompt: '',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: [],
            paneKey: `tab:${RIGHT}`
          }
        }
      })
      const savedLayout = mocks.state.terminalLayoutsByTabId.tab
      const hook = renderHook(() => useFixture(fixture, savedLayout.chatLeafId ?? null))
      expect(hook.result.current.effectiveChatViewMode).toBe(false)
      expect(hook.result.current.chatLeafId).toBeNull()
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
      expect(mocks.state.terminalLayoutsByTabId.tab).toEqual({
        ...savedLayout,
        chatLeafId: undefined
      })
      expect(fixture.managerRef.current.getPanes()).toHaveLength(2)
      expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
    }
  )

  it('batches a pane toggle into chat and back without selecting the active sibling', () => {
    mocks.state.setTabViewMode('tab', 'terminal')
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, null))
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('keeps a saved legacy chat and its explicit toggle available with its agents set to CLI', () => {
    const push = vi.fn()
    const fixture = makeFixture(undefined, { push })
    useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'bash', 2: 'codex' } } })
    mocks.state.terminalLayoutsByTabId.tab.ptyIdsByLeafId = {
      [LEFT]: 'remote:host:terminal',
      [RIGHT]: 'remote:host:chat'
    }
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    act(() =>
      useAppStore.setState({
        settings: createGlobalSettingsFixture({
          ...useAppStore.getState().settings,
          nativeChatProviders: { claude: false, codex: false }
        })
      })
    )
    hook.rerender()
    hook.result.current.persistLayoutSnapshot()
    expect(hook.result.current.effectiveChatViewMode).toBe(true)
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    expect(hook.result.current.canToggleChatForLeaf(LEFT)).toBe(false)
    expect(push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({ chatLeafId: RIGHT })
      })
    )
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
  })

  it('clears ownership when the tab-bar turns chat off, then targets the active sibling', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    act(() => mocks.state.setTabViewMode('tab', 'terminal'))
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
    act(() => mocks.state.setTabViewMode('tab', 'chat'))
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBe(LEFT)
  })

  it.each([
    { runtime: false, agent: 'codex' },
    { runtime: null, agent: 'codex' },
    { runtime: true, agent: 'openclaude' }
  ] as const)(
    'mounts a detached saved $agent owner at runtime $runtime without replacing its resources',
    ({ runtime, agent }) => {
      const source = {
        ...mocks.state.terminalLayoutsByTabId.tab,
        ptyIdsByLeafId: { [RIGHT]: 'existing-pty' },
        buffersByLeafId: { [RIGHT]: 'history' },
        scrollbackRefsByLeafId: { [RIGHT]: 'scrollback-ref' }
      }
      const detached = detachTerminalLayoutLeaf(source, RIGHT)!
      mocks.state.setTabLayout('tab', detached.detachedLayout)
      const fixture = makeFixture(undefined, undefined, runtime)
      fixture.managerRef.current.getPanes().shift()?.container.remove()
      const pane = fixture.managerRef.current.getPanes()[0]
      useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 2: agent } } })
      const hook = renderHook(() => useFixture(fixture, detached.detachedLayout.chatLeafId ?? null))
      const saved = mocks.state.terminalLayoutsByTabId.tab
      expect(hook.result.current.effectiveChatViewMode).toBe(runtime !== false && agent === 'codex')
      expect(fixture.managerRef.current.getPanes()[0]).toBe(pane)
      expect(saved.ptyIdsByLeafId).toEqual({ [RIGHT]: 'existing-pty' })
      expect(saved.buffersByLeafId).toEqual({ [RIGHT]: 'history' })
      expect(saved.scrollbackRefsByLeafId).toEqual({ [RIGHT]: 'scrollback-ref' })
    }
  )

  it('preserves confirmed-exit successor behavior while runtime is unknown, then exits on the active shell', () => {
    const fixture = makeFixture(undefined, undefined, null)
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    act(() => fixture.onAgentExitedRef.current(RIGHT))
    expect(hook.result.current.chatLeafId).toBe(LEFT)
    act(() => fixture.onAgentExitedRef.current(LEFT))
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it('keeps the current owner when a mount-time callback captures a pane for detaching', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    const mountedPersist = hook.result.current.persistLayoutSnapshot
    act(() => hook.result.current.toggleNativeChatForLeaf(LEFT))
    expect(hook.result.current.chatLeafId).toBe(LEFT)
    mountedPersist()
    const detached = detachTerminalLayoutLeaf(mocks.state.terminalLayoutsByTabId.tab, LEFT)
    expect(detached?.detachedLayout.chatLeafId).toBe(LEFT)
    expect(detached?.sourceLayout.chatLeafId).toBeUndefined()
  })

  it('does not resurrect an owner after chat is turned off and the split is resized', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    const mountedPersist = hook.result.current.persistLayoutSnapshot
    act(() => hook.result.current.switchNativeChatToTerminal())
    mountedPersist()
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('closing the chat leaf leaves an eligible terminal sibling in terminal mode', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    fixture.managerRef.current.getPanes().pop()?.container.remove()
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it('restores chat on the right with the left active and different numeric pane IDs', () => {
    const initialFixture = makeFixture()
    const original = renderHook(() => useFixture(initialFixture, RIGHT))
    original.result.current.persistLayoutSnapshot()
    const session = parseWorkspaceSession(
      JSON.parse(
        JSON.stringify({
          activeRepoId: null,
          activeWorktreeId: 'wt',
          activeTabId: 'tab',
          tabsByWorktree: {},
          terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId
        })
      )
    )
    expect(session.ok).toBe(true)
    if (!session.ok) {
      throw new Error('session did not parse')
    }
    original.unmount()
    const saved = session.value.terminalLayoutsByTabId.tab!
    mocks.state.setTabLayout('tab', saved)
    expect(saved.activeLeafId).toBe(LEFT)
    expect(saved.root).toMatchObject({ first: { leafId: LEFT }, second: { leafId: RIGHT } })
    const restored = makeFixture([20, 10])
    const hook = renderHook(() => useFixture(restored, saved.chatLeafId ?? null))
    const chatPane = restored.managerRef.current
      .getPanes()
      .find((pane) => pane.leafId === hook.result.current.chatLeafId)
    expect(chatPane?.id).toBe(10)
    restored.managerRef.current.getPanes().pop()?.container.remove()
    hook.rerender()
    expect(restored.managerRef.current.getPanes().map((pane) => pane.leafId)).toEqual([LEFT])
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })
})
