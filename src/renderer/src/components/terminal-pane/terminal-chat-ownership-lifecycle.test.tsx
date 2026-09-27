// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { resolveNativeChatLeafRoute } from '../native-chat/native-chat-leaf-routing'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import type { RemotePaneLayoutPusher } from './remote-pane-layout-push'

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const mocks = vi.hoisted(() => {
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
  const tab = { id: 'tab', entityId: 'tab', contentType: 'terminal', viewMode: 'chat' }
  const state = {
    terminalLayoutsByTabId: layouts,
    unifiedTabsByWorktree: { wt: [tab] },
    tabsByWorktree: {},
    settings: { experimentalNativeChat: true },
    pendingCodexPaneRestartIds: [],
    runtimePaneTitlesByTabId: { tab: { 1: 'codex', 2: 'codex' } },
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    setTabLayout: (_id: string, layout: TerminalLayoutSnapshot) => {
      layouts.tab = layout
    },
    setTabViewMode: (_id: string, mode: string) => {
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
  const { terminalLayoutEqual } = await import('@/lib/terminal-layout-equality')
  mocks.state.setTabLayout = (id, layout) => {
    if (terminalLayoutEqual(mocks.state.terminalLayoutsByTabId[id], layout)) {
      return
    }
    mocks.state.terminalLayoutsByTabId = { ...mocks.state.terminalLayoutsByTabId, [id]: layout }
    useAppStore.setState({ terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId })
  }
  mocks.state.setTabViewMode = (_id, mode) => {
    mocks.state.unifiedTabsByWorktree = {
      wt: [{ ...mocks.state.unifiedTabsByWorktree.wt[0], viewMode: mode }]
    }
    useAppStore.setState({ unifiedTabsByWorktree: mocks.state.unifiedTabsByWorktree })
  }
  const useAppStore = create(() => mocks.state)
  return { useAppStore }
})
vi.mock('@/runtime/web-runtime-session', () => ({ clearWebRuntimeTerminalBuffer: vi.fn() }))

function makeFixture(paneIds = [1, 2], remotePusher?: RemotePaneLayoutPusher) {
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
    return { id: paneIds[index], leafId, container: element }
  })
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0],
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  return {
    managerRef: { current: manager },
    containerRef: { current: container },
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
    setPaneTitles: vi.fn()
  }
}
function useFixture(fixture: ReturnType<typeof makeFixture>, initialOwner: string | null) {
  const [chatLeafId, setChatLeafId] = useState(initialOwner)
  const input = { ...fixture, chatLeafId, setChatLeafId }
  const chat = useTerminalPaneChatState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the chat hook.
    input as unknown as Parameters<typeof useTerminalPaneChatState>[0]
  )
  const layoutInput = { ...input, ...chat, setTabLayout: mocks.state.setTabLayout }
  const layout = useTerminalPaneLayoutPersistence(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the persistence hook.
    layoutInput as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
  )
  const activeLeafId = fixture.managerRef.current.getActivePane()?.leafId ?? null
  const mounted = fixture.managerRef.current.getPanes().some((pane) => pane.leafId === chatLeafId)
  const { applyNativeChatLeafRoute, isChatViewMode, isChatEligibleForLeaf } = chat
  useEffect(() => {
    applyNativeChatLeafRoute(
      resolveNativeChatLeafRoute({
        isChatViewMode,
        chatLeafId,
        activeLeafId,
        chatLeafStillMounted: mounted,
        activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId)
      })
    )
  }, [
    applyNativeChatLeafRoute,
    isChatEligibleForLeaf,
    isChatViewMode,
    chatLeafId,
    activeLeafId,
    mounted
  ])
  return { ...chat, ...layout, chatLeafId, setChatLeafId }
}

beforeEach(() => {
  mocks.state.settings.experimentalNativeChat = true
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
afterEach(cleanup)

describe('terminal chat ownership lifecycle', () => {
  it('batches a pane toggle into chat and back without selecting the active sibling', () => {
    mocks.state.setTabViewMode('tab', 'terminal')
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, null))
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('preserves the saved owner when this client disables native chat', () => {
    const push = vi.fn()
    const fixture = makeFixture(undefined, { push })
    mocks.state.terminalLayoutsByTabId.tab.ptyIdsByLeafId = {
      [LEFT]: 'remote:host:terminal',
      [RIGHT]: 'remote:host:chat'
    }
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    mocks.state.settings.experimentalNativeChat = false
    hook.rerender()
    hook.result.current.persistLayoutSnapshot()
    expect(hook.result.current.effectiveChatViewMode).toBe(false)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    expect(push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({ chatLeafId: RIGHT })
      })
    )
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
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
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
    // Closing the restored chat leaf must leave the left terminal untouched.
    restored.managerRef.current.getPanes().pop()?.container.remove()
    hook.rerender()
    expect(restored.managerRef.current.getPanes().map((pane) => pane.leafId)).toEqual([LEFT])
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })
})
