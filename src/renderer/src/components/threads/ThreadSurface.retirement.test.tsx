// @vitest-environment happy-dom
import {
  W,
  ordinary,
  first,
  second,
  classify,
  Desktop,
  visibleConversation,
  main,
  replaceMain,
  worktree
} from '@/components/threads/thread-surface.test-fixture'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import { act, render, renderHook, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTabGroup, makeWorktree } from '@/store/slices/store-test-helpers'
import { openNewThread } from '@/components/threads/thread-actions'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { navigateDesktopTab } from '@/lib/desktop-navigation'
import { registerTerminalUiRoutingIpcBridge } from '@/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import { drawTabsFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { useThreadDraft } from '@/components/threads/thread-navigation'
import { startAgentSessionFork } from '@/components/terminal-pane/terminal-agent-session-fork'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

async function disableFromRoute(route: 'thread-draft' | 'empty-workbench' | 'terminal') {
  await act(async () => openNewThread())
  act(() => {
    if (route === 'empty-workbench') {
      classify(ordinary)
      classify(first)
      classify(second)
      activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
    } else if (route === 'terminal') {
      navigateDesktopTab(first.id)
    }
    expect(useAppStore.getState().activeView).toBe(route)
    useAppStore.getState().openSettingsPage()
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
    })
    useAppStore.getState().closeSettingsPage()
    expect(useAppStore.getState().activeView).toBe(route)
  })
}

it.each(['thread-draft', 'empty-workbench', 'terminal'] as const)(
  'same-W IDs-only ordinary host focus while disabled, route=%s',
  async (route) => {
    await disableFromRoute(route)
    render(<Desktop />)
    expect(visibleConversation()).toEqual([first.entityId])
    const unsubs: (() => void)[] = []
    registerTerminalUiRoutingIpcBridge(unsubs)
    const focus = vi.mocked(window.api.ui.onFocusEditorTab).mock.calls[0][0]
    act(() => focus({ worktreeId: W, tabId: second.id }))
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(second.id)
    expect(visibleConversation()).toEqual([second.entityId])
    unsubs.forEach((fn) => fn())
  }
)

it.each(['thread-draft', 'empty-workbench', 'terminal'] as const)(
  'phone close of last ordinary chat while disabled lands welcome, route=%s',
  async (route) => {
    await disableFromRoute(route)
    main.close()
    useAppStore.setState({
      activeView: route,
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false },
      unifiedTabsByWorktree: { [W]: [ordinary] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: ordinary.id,
            tabOrder: [ordinary.id]
          })
        ]
      },
      openFiles: [],
      browserTabsByWorktree: {},
      tabsByWorktree: {}
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    render(<Desktop />)
    const finish = await pendingPhoneClose(ordinary.id)
    await finish()
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
    expect(screen.queryByTestId('strip-g')).toBeNull()
    expect(visibleConversation()).toEqual([])
  }
)

it.each(['browser', 'chat'] as const)(
  'ordinary %s publication selects locally in W1 behind sidebar W2',
  async (kind) => {
    main.close()
    const W2 = 'repo::/second-workspace'
    const destination = {
      ...second,
      id: 'W2-chat',
      entityId: 'W2-chat',
      worktreeId: W2,
      groupId: 'g2'
    }
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false },
      worktreesByRepo: {
        repo: [
          worktree,
          makeWorktree({ id: W2, repoId: 'repo', path: '/second-workspace', hostId: 'local' })
        ]
      },
      unifiedTabsByWorktree: { [W]: [ordinary, first, second], [W2]: [destination] },
      groupsByWorktree: {
        ...useAppStore.getState().groupsByWorktree,
        [W2]: [
          makeTabGroup({
            id: 'g2',
            worktreeId: W2,
            activeTabId: destination.id,
            tabOrder: [destination.id]
          })
        ]
      },
      activeGroupIdByWorktree: { [W]: 'g', [W2]: 'g2' }
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    render(<Desktop />)
    const { layoutApplyTestTransport } =
      await import('@/runtime/layout-apply-test-transport.test-fixture')
    layoutApplyTestTransport.answerWith('pending')
    let createdId = ''
    act(() => {
      createdId =
        kind === 'browser'
          ? useAppStore
              .getState()
              .createBrowserTab(W, 'https://example.com', { focusAddressBar: false }).id
          : openStructuredAgentSessionProvisionalTab({
              worktreeId: W,
              executionHostId: 'local',
              sessionId: 'cross-W-chat',
              agent: 'codex'
            }).id
    })
    act(() => {
      expect(
        activateAndRevealWorktree(W2, { executionHostId: 'local', navigationIntent: 'user-open' })
      ).not.toBe(false)
    })
    expect(useAppStore.getState().activeWorktreeId).toBe(W2)
    expect(visibleConversation()).toEqual([destination.entityId])
    await act(async () => {
      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await main.settle()
    })
    const shown = useAppStore
      .getState()
      .unifiedTabsByWorktree[W].find((t) =>
        kind === 'browser'
          ? t.contentType === 'browser' && t.entityId === createdId
          : t.id === createdId
      )
    expect(shown).toBeTruthy()
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(shown!.id)
    expect(useAppStore.getState().activeWorktreeId).toBe(W2)
    expect(visibleConversation()).toEqual([destination.entityId])
  }
)

it.each(['tasks', 'settings', 'terminal', 'draft'] as const)(
  'R4 phone close restores ordinary group MRU while section=%s',
  async (section) => {
    const { layoutApplyTestTransport } =
      await import('@/runtime/layout-apply-test-transport.test-fixture')
    const { isTabClosePending } = await import('@/runtime/layout-owner-pending-tabs')
    const { registerSessionTabIpcBridge } =
      await import('@/hooks/ipc-events/session-tab-ipc-bridge')
    main.close()
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false },
      activeView: 'terminal',
      unifiedTabsByWorktree: { [W]: [ordinary, first, second] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: second.id,
            tabOrder: [ordinary.id, first.id, second.id],
            recentTabIds: [ordinary.id, first.id, second.id]
          })
        ]
      },
      activeGroupIdByWorktree: { [W]: 'g' }
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    Object.assign(window.api, {
      gh: {
        ...window.api.gh,
        listWorkItems: vi.fn().mockResolvedValue({ items: [], hasMore: false })
      }
    })
    act(() => {
      if (section === 'settings') {
        useAppStore.getState().openSettingsPage()
      } else if (section === 'tasks') {
        useAppStore.getState().openTaskPage()
      }
    })
    if (section === 'draft') {
      await act(async () => openNewThread())
    }
    const sectionView = useAppStore.getState().activeView
    render(<Desktop />)
    let requestClose: Parameters<typeof window.api.ui.onSessionTabCloseRequest>[0] = () => {}
    const respond = vi.fn()
    Object.assign(window.api.ui, {
      onCloseSessionTab: vi.fn(() => () => {}),
      onSessionTabCloseRequest: (listener: typeof requestClose) => {
        requestClose = listener
        return () => {}
      },
      onMoveSessionTab: vi.fn(() => () => {}),
      respondSessionTabClose: respond
    })
    const unsubs: (() => void)[] = []
    registerSessionTabIpcBridge(unsubs)
    layoutApplyTestTransport.answerWith('pending')
    act(() => requestClose({ requestId: 'close-current-content', worktreeId: W, tabId: second.id }))
    expect(isTabClosePending(second.id)).toBe(true)
    await act(async () => {
      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await main.settle()
    })
    expect(isTabClosePending(second.id)).toBe(false)
    expect(useAppStore.getState().getTab(second.id)).toBeNull()
    expect(respond).toHaveBeenCalledExactlyOnceWith({ requestId: 'close-current-content' })
    expect(useAppStore.getState().activeView).toBe(sectionView)
    const actual = useAppStore.getState().getActiveTab(W)?.id
    Object.assign(window.api, {
      gh: {
        ...window.api.gh,
        listWorkItems: vi.fn().mockResolvedValue({ items: [], hasMore: false })
      }
    })
    act(() => {
      if (section === 'settings') {
        useAppStore.getState().closeSettingsPage()
      } else if (section === 'tasks') {
        useAppStore.getState().closeTaskPage()
      }
    })
    if (section === 'draft') {
      act(() => navigateDesktopTab(first.id))
    }
    expect(visibleConversation()).toEqual([actual])
    unsubs.forEach((fn) => fn())
    expect(actual).toBe(first.id)
    expect(visibleConversation()).toEqual([first.entityId])
  }
)

it('finishes an older actual fork without replacing a newer production New Thread', async () => {
  const originalCreate = useAppStore.getState().createWorktree
  const held = Promise.withResolvers<Awaited<ReturnType<typeof originalCreate>>>()
  const source = { ...worktree, branch: 'main' }
  const destination = makeWorktree({
    id: 'repo::/fork',
    repoId: 'repo',
    path: '/fork',
    branch: 'fork',
    hostId: 'local'
  })
  Object.assign(window.api.ui, { writeTerminalClipboardText: vi.fn(async () => {}) })
  useAppStore.setState({
    worktreesByRepo: { repo: [source] },
    createWorktree: vi.fn(() => held.promise)
  })
  render(<Desktop />)
  const pending = startAgentSessionFork({
    worktreeId: W,
    agent: null,
    prompt: 'User: compare OAuth options',
    // SAFETY: this no-agent fork only refocuses the source terminal after clipboard copy.
    pane: { terminal: { focus: vi.fn() } } as unknown as ManagedPane
  })
  expect(useAppStore.getState().createWorktree).toHaveBeenCalledOnce()
  await act(async () => openNewThread())
  const draftId = useThreadDraft.getState().draft!.draftId
  expect(screen.getByText(`Draft ${draftId}`)).toBeTruthy()
  await act(async () => {
    useAppStore.setState({ worktreesByRepo: { repo: [source, destination] } })
    held.resolve({ worktree: destination })
    expect(await pending).toBe(true)
    await main.settle()
  })
  useAppStore.setState({ createWorktree: originalCreate })
  expect(vi.mocked(window.api.ui.writeTerminalClipboardText)).toHaveBeenCalledWith(
    'User: compare OAuth options'
  )
  expect.soft(useAppStore.getState().activeWorktreeId).toBe(W)
  expect.soft(screen.queryByText(`Draft ${draftId}`)).toBeTruthy()
})

it.each(['store', 'direct-shell', 'group-shell'] as const)(
  'off-state explicit terminal %s supersedes retained draft on re-enable',
  async (entry) => {
    render(<Desktop />)
    await act(async () => openNewThread())
    const draftId = useThreadDraft.getState().draft!.draftId
    expect(screen.getByText(`Draft ${draftId}`)).toBeTruthy()
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
      })
    )
    const { useTabGroupCreationCommands } = await import('../tab-group/useTabGroupCreationCommands')
    const { result } = renderHook(() =>
      useTabGroupCreationCommands({
        groupId: 'g',
        worktreeId: W,
        worktreeState: {
          groups: [],
          unifiedTabs: [],
          terminalTabs: [],
          openFiles: [],
          browserTabs: [],
          expandedPaneByTabId: {},
          terminalLayoutsByTabId: {},
          generatedTabTitlesEnabled: false,
          mobileEmulatorEnabled: false
        }
      })
    )
    const { createNewTerminalTab } = await import('../terminal/terminal-tab-create')
    await act(async () => {
      if (entry === 'store') {
        await useAppStore.getState().openNewTerminalTabInActiveWorkspace('g')
      } else if (entry === 'direct-shell') {
        createNewTerminalTab(W, '/bin/zsh')
      } else {
        result.current.newTerminalWithShell('/bin/zsh')
      }
      await main.settle()
    })
    const terminal = useAppStore.getState().tabsByWorktree[W].at(-1)!
    expect(terminal).toBeTruthy()
    const selected = useAppStore.getState().getActiveTab(W)!
    expect(selected.contentType).toBe('terminal')
    expect(screen.queryByText(`Draft ${draftId}`)).toBeNull()
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: true }
      })
    )
    expect.soft(useAppStore.getState().getActiveTab(W)?.id).toBe(selected.id)
    expect.soft(screen.queryByText(`Draft ${draftId}`)).toBeNull()
    expect.soft(screen.queryByTestId('strip-g')).toBeTruthy()
  }
)

async function pendingPhoneClose(tabId: string, beforeRequest?: () => void) {
  const { layoutApplyTestTransport } =
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  const { isTabClosePending } = await import('@/runtime/layout-owner-pending-tabs')
  const { registerSessionTabIpcBridge } = await import('@/hooks/ipc-events/session-tab-ipc-bridge')
  let requestClose: Parameters<typeof window.api.ui.onSessionTabCloseRequest>[0] = () => {}
  const respond = vi.fn()
  Object.assign(window.api.ui, {
    onCloseSessionTab: vi.fn(() => () => {}),
    onSessionTabCloseRequest: (listener: typeof requestClose) => {
      requestClose = listener
      return () => {}
    },
    onMoveSessionTab: vi.fn(() => () => {}),
    respondSessionTabClose: respond
  })
  const unsubs: (() => void)[] = []
  registerSessionTabIpcBridge(unsubs)
  layoutApplyTestTransport.answerWith('pending')
  act(() => {
    beforeRequest?.()
    requestClose({ requestId: 'retire', worktreeId: W, tabId })
  })
  expect(isTabClosePending(tabId)).toBe(true)
  return async () => {
    await act(async () => {
      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await main.settle()
    })
    expect(isTabClosePending(tabId)).toBe(false)
    expect(useAppStore.getState().getTab(tabId)).toBeNull()
    expect(respond).toHaveBeenCalledExactlyOnceWith({ requestId: 'retire' })
    unsubs.forEach((fn) => fn())
  }
}

it.each(['draft', 'settings', 'tasks', 'empty', 'new-empty-off-settings'] as const)(
  'genuine-empty maintenance and page retirement have distinct scopes: %s',
  async (destination) => {
    main.close()
    useAppStore.setState({
      unifiedTabsByWorktree: { [W]: [ordinary] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: ordinary.id,
            tabOrder: [ordinary.id]
          })
        ]
      },
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      openFiles: []
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    render(<Desktop />)
    if (destination === 'draft') {
      await act(async () => openNewThread())
    }
    if (destination === 'settings') {
      act(() => useAppStore.getState().openSettingsPage())
    }
    if (destination === 'tasks') {
      Object.assign(window.api, {
        gh: {
          ...window.api.gh,
          listWorkItems: vi.fn().mockResolvedValue({ items: [], hasMore: false })
        }
      })
      act(() => useAppStore.getState().openTaskPage())
    }
    if (destination === 'empty') {
      act(() => {
        classify(ordinary)
        activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
      })
      expect(useAppStore.getState().activeView).toBe('empty-workbench')
    }
    const finish = await pendingPhoneClose(ordinary.id)
    if (destination === 'new-empty-off-settings') {
      act(() => {
        classify(ordinary)
        activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
        useAppStore.getState().openSettingsPage()
        useAppStore.setState({
          settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
        })
      })
    }
    const before = useAppStore.getState().activeView
    await finish()
    if (destination === 'draft' || destination === 'settings' || destination === 'tasks') {
      expect(useAppStore.getState().activeWorktreeId).toBeNull()
      expect(useAppStore.getState().activeView).toBe(before)
      if (destination === 'draft') {
        expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
      }
      act(() => {
        if (destination === 'settings') {
          useAppStore.getState().closeSettingsPage()
        }
        if (destination === 'tasks') {
          useAppStore.getState().closeTaskPage()
        }
      })
    } else {
      expect(useAppStore.getState().activeWorktreeId).toBe(W)
      expect(useAppStore.getState().activeView).toBe(before)
    }
  }
)

it('phone retirement cannot mint authority over an in-flight real New Thread entry', async () => {
  render(<Desktop />)
  let opening: Promise<void> | undefined
  const finish = await pendingPhoneClose(first.id, () => {
    opening = openNewThread()
  })
  await act(async () => opening)
  const id = useThreadDraft.getState().draft!.draftId
  expect(screen.getByText(`Draft ${id}`)).toBeTruthy()
  await finish()
  expect(screen.getByText(`Draft ${id}`)).toBeTruthy()
})

it.each([
  'new-live',
  'ordinary-off',
  'pre-capture-only',
  'experimental-target',
  'experimental-origin-off',
  'experimental-then-off',
  'experimental-aba',
  'live-then-draft',
  'retired-again',
  'new-draft'
] as const)(
  'local repair distinguishes a semantic destination from frame visual-first: %s',
  async (input) => {
    main.close()
    useAppStore.setState({
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: second.id,
            tabOrder: [ordinary.id, first.id, second.id],
            recentTabIds: [ordinary.id, first.id, second.id]
          })
        ]
      }
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    if (input === 'pre-capture-only') {
      await act(async () => openNewThread())
      act(() => {
        useAppStore.setState({
          settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
        })
        navigateDesktopTab(second.id)
      })
    }
    if (input === 'ordinary-off') {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
      })
    }
    if (input === 'experimental-origin-off') {
      classify(second)
    }
    render(<Desktop />)
    const finish = await pendingPhoneClose(second.id)
    if (input.startsWith('experimental-')) {
      act(() => {
        if (input !== 'experimental-origin-off') {
          classify(ordinary)
        }
        if (input === 'experimental-origin-off') {
          useAppStore.setState({
            settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
          })
        }
        navigateDesktopTab(ordinary.id)
        if (input === 'experimental-aba') {
          navigateDesktopTab(first.id)
          navigateDesktopTab(ordinary.id)
        }
        if (input === 'experimental-then-off') {
          useAppStore.setState({
            settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
          })
          navigateDesktopTab(first.id)
          navigateDesktopTab(ordinary.id)
        }
      })
    } else if (input === 'new-draft') {
      await act(async () => openNewThread())
    } else {
      act(() => {
        navigateDesktopTab(ordinary.id)
        if (input === 'retired-again') {
          navigateDesktopTab(second.id)
        }
      })
    }
    if (input === 'live-then-draft') {
      await act(async () => openNewThread())
    }
    const discovery = countRetirementDiscovery()
    try {
      await finish()
    } finally {
      discovery.restore()
    }
    if (['new-live', 'ordinary-off', 'pre-capture-only', 'new-draft'].includes(input)) {
      expect(discovery.counts).toEqual({ target: 0, otherWorkspace: 0, group: 0 })
    }
    const expected =
      input.startsWith('experimental-') || input === 'live-then-draft' ? ordinary.id : first.id
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(expected)
    if (input === 'new-draft' || input === 'live-then-draft') {
      expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
    } else {
      expect(visibleConversation()).toEqual([expected])
    }
  }
)

function countRetirementDiscovery() {
  const find = Array.prototype.find
  const counts = { target: 0, otherWorkspace: 0, group: 0 }
  const spy = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
    this: unknown[],
    predicate,
    thisArg
  ) {
    // Charge only the production validator, excluding frame, render and legitimate repair work.
    const validating = new Error('Retirement discovery counter').stack?.includes(
      'hasNewerDesktopSelection'
    )
    const targetBucket = this === useAppStore.getState().unifiedTabsByWorktree[W]
    return find.call(this, (value, index, array) => {
      if (validating && value && typeof value === 'object') {
        if ('contentType' in value && 'worktreeId' in value) {
          if (targetBucket) {
            counts.target++
          } else {
            counts.otherWorkspace++
          }
        } else if ('tabOrder' in value) {
          counts.group++
        }
      }
      return predicate.call(thisArg, value, index, array)
    })
  })
  return { counts, restore: () => spy.mockRestore() }
}

it.each([20, 200])(
  'pending retirement discovers one current scoped target at N=%i',
  async (count) => {
    for (const thenDraft of [false, true]) {
      main.close()
      const fillers = Array.from({ length: count - 2 }, (_, i) => ({
        ...first,
        id: `filler-${i}`,
        entityId: `filler-${i}`
      }))
      const tabs = [...fillers, first, second, ordinary]
      useAppStore.setState({
        activeView: 'terminal',
        unifiedTabsByWorktree: { [W]: tabs },
        groupsByWorktree: {
          [W]: [
            makeTabGroup({
              id: 'g',
              worktreeId: W,
              activeTabId: second.id,
              tabOrder: tabs.map((t) => t.id),
              recentTabIds: [ordinary.id, first.id, second.id]
            })
          ]
        }
      })
      replaceMain(await drawTabsFromMain(useAppStore))
      useAppStore.setState({
        unifiedTabsByWorktree: {
          prefix: fillers.map((t) => ({ ...t, worktreeId: 'prefix' })),
          ...useAppStore.getState().unifiedTabsByWorktree
        }
      })
      classify(ordinary)
      const rendered = render(<Desktop />)
      const finish = await pendingPhoneClose(second.id)
      act(() => navigateDesktopTab(ordinary.id))
      if (thenDraft) {
        await act(async () => openNewThread())
      }
      const discovery = countRetirementDiscovery()
      try {
        await finish()
      } finally {
        discovery.restore()
      }
      expect(useAppStore.getState().unifiedTabsByWorktree[W]).toHaveLength(count)
      expect(useAppStore.getState().getActiveTab(W)?.id).toBe(ordinary.id)
      if (thenDraft) {
        expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
      } else {
        expect(visibleConversation()).toEqual([ordinary.entityId])
      }
      console.info('retirement discovery', { count, thenDraft, ...discovery.counts })
      expect.soft(discovery.counts.target).toBe(count)
      expect.soft(discovery.counts.otherWorkspace).toBe(0)
      expect.soft(discovery.counts.group).toBe(1)
      rendered.unmount()
    }
  }
)

it.each([
  'missing',
  'moved-workspace',
  'moved-bucket',
  'moved-group',
  'moved-host',
  'deselected',
  'missing-group',
  'other-workspace',
  'other-group'
] as const)(
  'pending retirement revalidates current target after frame/settlement: %s',
  async (change) => {
    render(<Desktop />)
    const finish = await pendingPhoneClose(second.id)
    act(() => {
      if (change === 'other-workspace' || change === 'other-group') {
        const target = {
          ...ordinary,
          id: 'elsewhere',
          worktreeId: change === 'other-workspace' ? 'elsewhere' : W,
          groupId: 'elsewhere'
        }
        useAppStore.setState((s) => ({
          unifiedTabsByWorktree: {
            ...s.unifiedTabsByWorktree,
            [target.worktreeId]: [...(s.unifiedTabsByWorktree[target.worktreeId] ?? []), target]
          },
          groupsByWorktree: {
            ...s.groupsByWorktree,
            [target.worktreeId]: [
              ...(s.groupsByWorktree[target.worktreeId] ?? []),
              makeTabGroup({
                id: 'elsewhere',
                worktreeId: target.worktreeId,
                tabOrder: [target.id]
              })
            ]
          }
        }))
        navigateDesktopTab(target.id)
      } else {
        navigateDesktopTab(ordinary.id)
      }
    })
    await act(async () => openNewThread())
    const { afterPendingTab } = await import('@/runtime/layout-owner-pending-tabs')
    afterPendingTab(second.id, () => {
      const s = useAppStore.getState()
      if (change === 'other-workspace' || change === 'other-group') {
        return
      }
      useAppStore.setState({
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          ...(change === 'moved-bucket'
            ? { elsewhere: [{ ...ordinary, worktreeId: 'elsewhere' }] }
            : {}),
          [W]: s.unifiedTabsByWorktree[W]
            .filter(
              (t) => (change !== 'missing' && change !== 'moved-bucket') || t.id !== ordinary.id
            )
            .map((t) =>
              t.id !== ordinary.id
                ? t
                : {
                    ...t,
                    worktreeId: change === 'moved-workspace' ? 'elsewhere' : t.worktreeId,
                    groupId: change === 'moved-group' ? 'elsewhere' : t.groupId,
                    executionHostId: change === 'moved-host' ? 'other-host' : t.executionHostId
                  }
            )
        },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [W]:
            change === 'missing-group'
              ? []
              : s.groupsByWorktree[W].map((g) => ({
                  ...g,
                  activeTabId: change === 'deselected' ? first.id : g.activeTabId
                }))
        }
      })
    })
    const discovery = countRetirementDiscovery()
    try {
      await finish()
    } finally {
      discovery.restore()
    }
    expect(useAppStore.getState().getActiveTab(W)?.id ?? null).toBe(
      change === 'missing-group' ? null : first.id
    )
    expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
    if (change === 'other-workspace' || change === 'other-group') {
      expect(discovery.counts).toEqual({ target: 0, otherWorkspace: 0, group: 0 })
    } else {
      expect(discovery.counts.target).toBeLessThanOrEqual(2)
      expect(discovery.counts.otherWorkspace).toBe(0)
      expect(discovery.counts.group).toBeLessThanOrEqual(1)
    }
  }
)
