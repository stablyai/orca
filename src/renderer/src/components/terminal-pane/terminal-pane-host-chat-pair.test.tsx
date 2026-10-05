// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { useTerminalPaneChatPairSource } from './use-terminal-pane-chat-pair-source'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'
import { createRemotePaneLayoutPusher } from './remote-pane-layout-push'
import { resolveNativeChatLeafRoute } from '../native-chat/native-chat-leaf-routing'
import {
  A,
  B,
  C,
  TERMINAL_TAB_ID,
  WT,
  applyHostSnapshot,
  effectivePair,
  installFakeHost,
  makeHostPairSnapshot,
  resetPairedStore,
  storedPair
} from '@/runtime/terminal-chat-pair-host-test-rig'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

type FakePane = { id: number; leafId: string; container: HTMLElement }

function makeManager(leaves: string[]) {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  const panes: FakePane[] = leaves.map((leafId, index) => {
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = String(index + 1)
    element.dataset.leafId = leafId
    split.append(element)
    return { id: index + 1, leafId, container: element }
  })
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0] ?? null,
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  return { manager, container }
}

/** The pane's chat hooks over the real store, with the foundation's own pair source. */
function renderPane(leaves: string[] = [A, B]) {
  const { manager, container } = makeManager(leaves)
  const onAgentExitedRef = { current: (_leafId: string) => {} }
  const paneTitlesRef: { current: Record<number, string> } = { current: {} }
  const pusher = createRemotePaneLayoutPusher()
  const hook = renderHook(() => {
    const { chatPairAuthority } = useAppStore(
      useShallow((store) => selectTerminalPaneHostState(store, WT))
    )
    const source = useTerminalPaneChatPairSource(TERMINAL_TAB_ID, chatPairAuthority)
    const fixture = {
      ...source,
      chatPairAuthority,
      managerRef: { current: manager },
      containerRef: { current: container },
      nativeChatTranscriptIsLocalReadable: true,
      onAgentExitedRef,
      paneCount: manager.getPanes().length,
      tabId: TERMINAL_TAB_ID,
      worktreeId: WT,
      tabWideAgentHintLeafId: null,
      setTabWideAgentHintLeafId: vi.fn(),
      clearedScrollbackLeafIdsRef: { current: new Set<string>() },
      expandedPaneIdRef: { current: null },
      paneTitles: {},
      paneTitlesRef,
      paneTransportsRef: { current: new Map() },
      remotePaneLayoutPusherRef: { current: pusher },
      removedTitleLeafIdsRef: { current: new Set<string>() },
      setPaneTitles: vi.fn()
    }
    const chat = useTerminalPaneChatState(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the chat hook.
      fixture as unknown as Parameters<typeof useTerminalPaneChatState>[0]
    )
    const layout = useTerminalPaneLayoutPersistence(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the persistence hook.
      {
        ...fixture,
        ...chat,
        setTabLayout: useAppStore.getState().setTabLayout
      } as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
    )
    const { chatLeafId } = source
    const activeLeafId = manager.getActivePane()?.leafId ?? null
    const mounted = manager.getPanes().some((pane) => pane.leafId === chatLeafId)
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
    return { ...chat, ...layout, chatLeafId, chatPairAuthority }
  })
  return { hook, onAgentExitedRef, paneTitlesRef }
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled()
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }
  })
}

function hostSays(pair: Parameters<typeof makeHostPairSnapshot>[0]): void {
  act(() => applyHostSnapshot(makeHostPairSnapshot(pair)))
}

function chatReply(leafId: string | null, superseded = false) {
  return {
    updated: true as const,
    chatView: { viewMode: leafId ? ('chat' as const) : ('terminal' as const), chatLeafId: leafId },
    ...(superseded ? { superseded: true as const } : {})
  }
}

let host: ReturnType<typeof installFakeHost>
beforeEach(() => {
  resetPairedStore()
  host = installFakeHost()
  useAppStore.setState({
    runtimePaneTitlesByTabId: { [TERMINAL_TAB_ID]: { 1: 'codex', 2: 'codex', 3: 'codex' } }
  })
})
afterEach(cleanup)

describe('a paired desktop pane on a host-owned pair', () => {
  it('sends a fenced leaf write and leaves the owner out of every layout push', async () => {
    hostSays({ viewMode: 'terminal' })
    const { hook } = renderPane()
    expect(hook.result.current.chatPairAuthority).toBe('host')
    act(() => hook.result.current.toggleNativeChatForLeaf(B))
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(B)
    // The store keeps host truth: the pane's stamped owner is not stored.
    expect(storedPair().owner).toBeUndefined()
    await settle()
    expect(host.pairWrites().map((write) => write.params.tabId)).toEqual([`host-tab-1::${B}`])
    host.pairWrites()[0]!.resolve(chatReply(B))
    hostSays({ viewMode: 'chat', owner: B })
    await settle()
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: B })
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    expect(host.layoutPushes().length).toBeGreaterThan(0)
    for (const push of host.layoutPushes()) {
      expect(push.params).not.toHaveProperty('chatLeafId')
    }
  })

  it('sends no owner on title and geometry churn', async () => {
    hostSays({ viewMode: 'chat', owner: A })
    const { hook, paneTitlesRef } = renderPane()
    await settle()
    paneTitlesRef.current = { 1: 'renamed' }
    act(() => hook.result.current.persistLayoutSnapshot())
    await settle()
    expect(host.layoutPushes().some((push) => push.params.titlesByLeafId)).toBe(true)
    for (const push of host.layoutPushes()) {
      expect(push.params).not.toHaveProperty('chatLeafId')
    }
    expect(host.pairWrites()).toEqual([])
  })

  it('sends A, B, A as three writes with increasing seqs when each is acknowledged', async () => {
    hostSays({ viewMode: 'chat', owner: C, leaves: [A, B, C] })
    const { hook } = renderPane([A, B, C])
    for (const [index, leaf] of [A, B, A].entries()) {
      act(() => hook.result.current.toggleNativeChatForLeaf(leaf))
      await settle()
      host.pairWrites()[index]!.resolve(chatReply(leaf))
      hostSays({ viewMode: 'chat', owner: leaf, leaves: [A, B, C] })
      await settle()
    }
    expect(
      host.pairWrites().map((write) => [write.params.tabId, write.params.chatViewWrite])
    ).toEqual([
      [`host-tab-1::${A}`, { writerId: expect.any(String), seq: 1 }],
      [`host-tab-1::${B}`, { writerId: expect.any(String), seq: 2 }],
      [`host-tab-1::${A}`, { writerId: expect.any(String), seq: 3 }]
    ])
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: A })
  })

  it('sends all three at once and ends on A when the host applies s3 before s2', async () => {
    hostSays({ viewMode: 'chat', owner: C, leaves: [A, B, C] })
    const { hook } = renderPane([A, B, C])
    act(() => hook.result.current.toggleNativeChatForLeaf(A))
    act(() => hook.result.current.toggleNativeChatForLeaf(B))
    act(() => hook.result.current.toggleNativeChatForLeaf(A))
    await settle()
    const writes = host.pairWrites()
    expect(writes.map((write) => write.params.chatViewWrite)).toEqual([
      { writerId: expect.any(String), seq: 1 },
      { writerId: expect.any(String), seq: 2 },
      { writerId: expect.any(String), seq: 3 }
    ])
    writes[2]!.resolve(chatReply(A))
    hostSays({ viewMode: 'chat', owner: A, leaves: [A, B, C] })
    writes[1]!.resolve(chatReply(A, true))
    writes[0]!.resolve(chatReply(A, true))
    await settle()
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect(hook.result.current.chatLeafId).toBe(A)
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
  })

  it('turns a confirmed agent exit into one terminal write', async () => {
    hostSays({ viewMode: 'chat', owner: A })
    const { hook, onAgentExitedRef } = renderPane()
    await settle()
    act(() => onAgentExitedRef.current(A))
    await settle()
    expect(host.pairWrites().map((write) => [write.params.tabId, write.params.viewMode])).toEqual([
      ['host-tab-1', 'terminal']
    ])
    expect(hook.result.current.isChatViewMode).toBe(false)
  })

  it('does not exit chat for a host owner that is not mounted here yet', async () => {
    hostSays({ viewMode: 'chat', owner: C, leaves: [A, B, C] })
    const { hook } = renderPane([A, B])
    await settle()
    expect(host.pairWrites()).toEqual([])
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(effectivePair()).toEqual({ viewMode: 'chat', chatLeafId: C })
  })

  it('shows an ownerless host chat on the active leaf without writing', async () => {
    hostSays({ viewMode: 'chat' })
    const { hook } = renderPane()
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(A)
    expect(host.pairWrites()).toEqual([])
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: undefined })
    hostSays({ viewMode: 'chat', owner: B })
    await settle()
    expect(hook.result.current.chatLeafId).toBe(B)
    hostSays({ viewMode: 'terminal' })
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(false)
    hostSays({ viewMode: 'chat' })
    await settle()
    expect(hook.result.current.chatLeafId).toBe(A)
    expect(host.pairWrites()).toEqual([])
  })

  it('shows a tab-level switch to chat on the active leaf at once, then follows the host pick', async () => {
    hostSays({ viewMode: 'terminal' })
    const { hook } = renderPane()
    await settle()
    const unifiedTabId = useAppStore
      .getState()
      .unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === TERMINAL_TAB_ID)?.id
    act(() => useAppStore.getState().toggleTabViewMode(unifiedTabId!))
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(A)
    expect(host.pairWrites().map((write) => write.params.tabId)).toEqual(['host-tab-1'])
    host.pairWrites()[0]!.resolve({
      updated: true,
      chatView: { viewMode: 'chat', chatLeafId: null }
    })
    await settle()
    // The host desktop's own pane claims its active leaf and publishes it.
    hostSays({ viewMode: 'chat', owner: B })
    await settle()
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    expect(hook.result.current.chatLeafId).toBe(B)
    expect(host.pairWrites()).toHaveLength(1)
  })

  it('keeps the shown host owner when the host stops carrying the marker', async () => {
    hostSays({ viewMode: 'chat', owner: B })
    const { hook } = renderPane()
    await settle()
    hostSays({ marker: false, viewMode: 'chat', owner: B })
    await settle()
    expect(hook.result.current.chatPairAuthority).toBe('legacy')
    expect(hook.result.current.chatLeafId).toBe(B)
    for (const push of host.layoutPushes()) {
      expect(push.params.chatLeafId ?? B).toBe(B)
    }
  })

  it('turns a confirmed agent exit on an ownerless host chat into one terminal write', async () => {
    hostSays({ viewMode: 'chat' })
    const { hook, onAgentExitedRef } = renderPane()
    await settle()
    act(() => onAgentExitedRef.current(A))
    await settle()
    expect(host.pairWrites().map((write) => [write.params.tabId, write.params.viewMode])).toEqual([
      ['host-tab-1', 'terminal']
    ])
    expect(hook.result.current.isChatViewMode).toBe(false)
  })

  it('keeps a click on the clicked leaf when the host answers with an ownerless chat', async () => {
    // A headless host with no stored layout cannot hold an owner and answers every claim this way.
    hostSays({ viewMode: 'chat' })
    const { hook } = renderPane()
    await settle()
    act(() => hook.result.current.toggleNativeChatForLeaf(B))
    await settle()
    host.pairWrites()[0]!.resolve({
      updated: true,
      chatView: { viewMode: 'chat', chatLeafId: null }
    })
    await settle()
    expect(useAppStore.getState().pendingChatPairByTabId).toEqual({})
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(B)
    expect(host.pairWrites()).toHaveLength(1)
  })

  it('never lets a sibling claim chat whose present owner left the tree', async () => {
    hostSays({ viewMode: 'chat', owner: '99999999-9999-4999-8999-999999999999' })
    const { hook } = renderPane()
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(false)
    expect(host.pairWrites()).toEqual([])
  })

  it('follows a host switch while mounted in terminal, with no echo and no owner push', async () => {
    hostSays({ viewMode: 'terminal' })
    const { hook } = renderPane()
    await settle()
    // A phone switch reaches a headless host, which publishes the new pair.
    hostSays({ viewMode: 'chat', owner: B })
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(B)
    expect(host.pairWrites()).toEqual([])
    for (const push of host.layoutPushes()) {
      expect(push.params).not.toHaveProperty('chatLeafId')
    }
  })
})

describe('a paired desktop pane on a host without the marker', () => {
  it('sends today’s parent write and an owner-carrying push, and keeps its own owner', async () => {
    hostSays({ marker: false, viewMode: 'terminal' })
    const { hook } = renderPane()
    expect(hook.result.current.chatPairAuthority).toBe('legacy')
    act(() => hook.result.current.toggleNativeChatForLeaf(B))
    await settle()
    expect(host.pairWrites().map((write) => write.params)).toEqual([
      { worktree: expect.any(String), tabId: 'host-tab-1', viewMode: 'chat' }
    ])
    expect(host.layoutPushes().some((push) => push.params.chatLeafId === B)).toBe(true)
    // An old host echoes its own value; the client keeps its view and owner.
    hostSays({ marker: false, viewMode: 'terminal' })
    await settle()
    expect(hook.result.current.isChatViewMode).toBe(true)
    expect(hook.result.current.chatLeafId).toBe(B)
  })
})
