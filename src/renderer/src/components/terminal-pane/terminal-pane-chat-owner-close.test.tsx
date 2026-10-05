// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { resolveNativeChatLeafRoute } from '../native-chat/native-chat-leaf-routing'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'
import { useAppStore } from '../../store'
import { EMPTY_LAYOUT } from './layout-serialization'

import type { AgentExitObservationOrigin } from '../../../../shared/agent-exit-retirement'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/web-runtime-session', () => ({ clearWebRuntimeTerminalBuffer: vi.fn() }))

const WT = 'repo1::/tmp/local'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

type FakePane = { id: number; leafId: string; container: HTMLElement }

/** Mirrors PaneManager's synchronous close: pane removal, then onLayoutChanged → persist. */

function makeManager(onLayoutChanged: () => void) {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  let panes: FakePane[] = [A, B].map((leafId, index) => {
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
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId])),
    closePane: (leafId: string, options: { persist: boolean } = { persist: true }) => {
      panes = panes.filter((pane) => pane.leafId !== leafId)
      split.remove()
      for (const pane of panes) {
        container.append(pane.container)
      }
      if (options.persist) {
        onLayoutChanged()
      }
    }
  }
  return { manager, container }
}

function splitLayout(chatLeafId?: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: A },
      second: { type: 'leaf', leafId: B }
    },
    activeLeafId: A,
    expandedLeafId: null,
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

function seedTab(
  pair: { viewMode?: 'chat' | 'terminal'; owner?: string; plainShell?: boolean } = {}
): string {
  const store = useAppStore.getState()
  const tab = store.createTab(
    WT,
    undefined,
    undefined,
    pair.plainShell ? undefined : { launchAgent: 'codex' }
  )
  const unifiedId = useAppStore
    .getState()
    .unifiedTabsByWorktree[WT]!.find((unified) => unified.entityId === tab.id)!.id
  if (pair.viewMode) {
    useAppStore.getState().setTabViewMode(unifiedId, pair.viewMode)
  }
  useAppStore.getState().setTabLayout(tab.id, splitLayout(pair.owner))
  return tab.id
}

function storePair(tabId: string) {
  const state = useAppStore.getState()
  return {
    viewMode: state.unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === tabId)?.viewMode,
    owner: state.terminalLayoutsByTabId[tabId]?.chatLeafId
  }
}

function published(tabId: string) {
  return buildMobileSessionTabSnapshots(useAppStore.getState())
    .flatMap((snapshot) => snapshot.tabs)
    .flatMap((tab) =>
      tab.type === 'terminal' && tab.parentTabId === tabId
        ? [{ viewMode: tab.viewMode, owner: tab.parentLayout?.chatLeafId }]
        : []
    )
}

function renderPane(tabId: string) {
  const persistRef: { current: () => void } = { current: () => {} }
  const { manager, container } = makeManager(() => persistRef.current())
  const onAgentExitedRef: {
    current: (leafId: string, origin?: AgentExitObservationOrigin) => void
  } = { current: () => {} }
  const hook = renderHook(() => {
    // Same source the pane foundation uses on a local worktree.
    const savedLayout = useAppStore((state) => state.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
    const chatLeafId = savedLayout.chatLeafId ?? null
    const fixture = {
      managerRef: { current: manager },
      containerRef: { current: container },
      nativeChatTranscriptIsLocalReadable: true,
      onAgentExitedRef,
      paneCount: manager.getPanes().length,
      tabId,
      worktreeId: WT,
      tabWideAgentHintLeafId: null,
      setTabWideAgentHintLeafId: vi.fn(),
      clearedScrollbackLeafIdsRef: { current: new Set<string>() },
      expandedPaneIdRef: { current: null },
      paneTitles: {},
      paneTitlesRef: { current: {} },
      paneTransportsRef: { current: new Map() },
      remotePaneLayoutPusherRef: { current: null },
      removedTitleLeafIdsRef: { current: new Set<string>() },
      setPaneTitles: vi.fn(),
      chatLeafId,
      savedLayout,
      setChatLeafId: vi.fn(),
      storeOwnsChatPair: true
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
    persistRef.current = layout.persistLayoutSnapshot
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
    return { ...chat, ...layout, chatLeafId }
  })
  return { hook, manager, onAgentExitedRef }
}

beforeEach(() => {
  // @ts-expect-error -- partial window stub is sufficient for these store-backed hook tests
  globalThis.window.api = { ui: { set: vi.fn() }, pty: { clearBuffer: vi.fn() } }
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: true }
  })
})
afterEach(cleanup)

describe('closing the chat-owning pane on a local tab', () => {
  it.each([
    ['an eligible agent', { 2: 'codex' }],
    ['a plain shell', {}]
  ])('leaves chat before any effect runs when the sibling is %s', async (_label, titles) => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    useAppStore.setState({ runtimePaneTitlesByTabId: { [tabId]: titles } })
    const { manager } = renderPane(tabId)
    expect(storePair(tabId)).toEqual({ viewMode: 'chat', owner: A })

    manager.closePane(A)

    // Synchronous: the store already holds the closed pair, with no ownerless chat in between.
    expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
    await act(async () => {})
    expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(published(tabId)).toEqual([{ viewMode: 'terminal', owner: undefined }])
  })

  it('keeps chat on its owner when a non-owning pane closes', async () => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    const { manager } = renderPane(tabId)
    manager.closePane(B)
    await act(async () => {})
    expect(storePair(tabId)).toEqual({ viewMode: 'chat', owner: A })
  })

  it('exits through the route when layout persistence is suppressed, never claiming the sibling', async () => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    useAppStore.setState({ runtimePaneTitlesByTabId: { [tabId]: { 2: 'codex' } } })
    const { hook, manager } = renderPane(tabId)
    manager.closePane(A, { persist: false })
    await act(async () => {
      hook.rerender()
    })
    expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
  })
})

describe("a confirmed agent exit on this desktop's own tab (F2)", () => {
  it('turns the pane chat terminal once and never moves it to an eligible sibling (R1C-1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tabId = seedTab({ viewMode: 'chat', owner: A })
      useAppStore.setState({ runtimePaneTitlesByTabId: { [tabId]: { 1: 'codex', 2: 'codex' } } })
      const { onAgentExitedRef } = renderPane(tabId)
      await act(async () => {})
      vi.setSystemTime(5_000)
      act(() => onAgentExitedRef.current(A, { ptyId: null, observedAtMs: 5_000 }))
      await act(async () => {})
      expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
      expect(published(tabId)).toEqual([
        { viewMode: 'terminal', owner: undefined },
        { viewMode: 'terminal', owner: undefined }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("is not superseded by the tab bar's hint clear for the same exit (R2-1)", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tabId = seedTab({ viewMode: 'chat', owner: A })
      const { onAgentExitedRef } = renderPane(tabId)
      await act(async () => {})
      // Seen at 5 s; useTabAgent clears the launch hint from the same evidence before the fact lands.
      vi.setSystemTime(5_020)
      act(() => useAppStore.getState().clearTabLaunchAgent(tabId))
      vi.setSystemTime(5_080)
      act(() => onAgentExitedRef.current(A, { ptyId: null, observedAtMs: 5_000 }))
      await act(async () => {})
      expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an exit observed before the user chose chat again on that pane (R4.1-2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    try {
      const tabId = seedTab({ viewMode: 'chat', owner: A })
      const { onAgentExitedRef } = renderPane(tabId)
      await act(async () => {})
      // The exit is seen at 2 s, then terminal -> chat(A) commits before the fact is delivered.
      vi.setSystemTime(3_000)
      act(() =>
        useAppStore.getState().applyTerminalChatPair(tabId, null, 'terminal', { intent: true })
      )
      act(() => useAppStore.getState().applyTerminalChatPair(tabId, A, 'chat', { intent: true }))
      await act(async () => {})
      act(() => onAgentExitedRef.current(A, { ptyId: null, observedAtMs: 2_000 }))
      await act(async () => {})
      expect(storePair(tabId)).toEqual({ viewMode: 'chat', owner: A })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a stale pane write after an external pair change', () => {
  it('keeps an externally applied owner when a previously registered capture runs', async () => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    const { hook } = renderPane(tabId)
    const registeredCapture = hook.result.current.persistLayoutSnapshot

    useAppStore.getState().applyTerminalChatPair(tabId, B, 'chat')
    registeredCapture()

    expect(storePair(tabId)).toEqual({ viewMode: 'chat', owner: B })
    await act(async () => {})
    expect(published(tabId)).toEqual([
      { viewMode: 'chat', owner: B },
      { viewMode: 'chat', owner: B }
    ])
  })

  it('drops a route computed before an external pair change', async () => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    const { hook } = renderPane(tabId)
    const staleApplyRoute = hook.result.current.applyNativeChatLeafRoute

    useAppStore.getState().applyTerminalChatPair(tabId, B, 'chat')
    staleApplyRoute({ chatLeafId: null, exitChat: true })

    expect(storePair(tabId)).toEqual({ viewMode: 'chat', owner: B })
  })
})

describe('the local route never enters chat', () => {
  it.each([
    ['an untouched agent tab', undefined],
    ['an explicit terminal tab', 'terminal' as const]
  ])('writes nothing when mounting %s', async (_label, viewMode) => {
    const tabId = seedTab(viewMode ? { viewMode } : {})
    useAppStore.setState({ runtimePaneTitlesByTabId: { [tabId]: { 1: 'codex' } } })
    const before = storePair(tabId)
    renderPane(tabId)
    await act(async () => {})
    expect(storePair(tabId)).toEqual(before)
    expect(published(tabId).map((row) => row.viewMode)).toEqual([viewMode, viewMode])
  })

  it('writes nothing when mounting a plain terminal', async () => {
    const tabId = seedTab({ plainShell: true })
    renderPane(tabId)
    await act(async () => {})
    expect(storePair(tabId)).toEqual({ viewMode: undefined, owner: undefined })
    expect(published(tabId).map((row) => row.viewMode)).toEqual([undefined, undefined])
  })

  it('reads a restored owner that left the tree as terminal and never claims the sibling', async () => {
    const tabId = seedTab({ viewMode: 'chat' })
    // Restored records skip setTabLayout, so the stale owner reaches the store as persisted.
    useAppStore.setState((state) => ({
      runtimePaneTitlesByTabId: { [tabId]: { 1: 'codex', 2: 'codex' } },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [tabId]: splitLayout('33333333-3333-4333-8333-333333333333')
      }
    }))
    expect(published(tabId)).toEqual([
      { viewMode: 'terminal', owner: undefined },
      { viewMode: 'terminal', owner: undefined }
    ])
    const { hook } = renderPane(tabId)
    await act(async () => {})
    expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(hook.result.current.chatLeafId).toBeNull()
  })

  it('stays terminal after switching back once every effect has run', async () => {
    const tabId = seedTab({ viewMode: 'chat', owner: B })
    useAppStore.setState({ runtimePaneTitlesByTabId: { [tabId]: { 1: 'codex', 2: 'codex' } } })
    const { hook } = renderPane(tabId)
    await act(async () => {
      hook.result.current.switchNativeChatToTerminal()
    })
    await act(async () => {})
    expect(storePair(tabId)).toEqual({ viewMode: 'terminal', owner: undefined })
  })
})

describe("a same-value switch on this desktop's tab (R2-3)", () => {
  it('republishes the pane token even though no store field changed', () => {
    const tabId = seedTab({ viewMode: 'chat', owner: A })
    const tokenOfA = () =>
      buildMobileSessionTabSnapshots(useAppStore.getState())
        .flatMap((snapshot) => snapshot.tabs)
        .find((tab) => tab.type === 'terminal' && tab.parentTabId === tabId && tab.leafId === A)
    const before = tokenOfA()
    expect(before?.type === 'terminal' && before.presentationToken).toBeTruthy()
    useAppStore.getState().applyTerminalChatPair(tabId, A, 'chat', { intent: true })
    const after = tokenOfA()
    expect(after?.type === 'terminal' ? after.presentationToken : null).not.toBe(
      before?.type === 'terminal' ? before.presentationToken : null
    )
  })
})
