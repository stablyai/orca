// @vitest-environment happy-dom
import {
  W,
  ordinary,
  first,
  second,
  repo,
  worktree,
  classify,
  Desktop,
  visibleConversation,
  main,
  replaceMain
} from './thread-surface.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { openNewThread } from './thread-actions'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import { navigateDesktopTab } from '@/lib/desktop-navigation'

import { setThreadTestPage } from './thread-page.test-fixture'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useAppStore } from '@/store'
import { makeWorktree, makeTabGroup } from '@/store/slices/store-test-helpers'

import { useThreadDraft } from './thread-navigation'

import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

import { registerTerminalUiRoutingIpcBridge } from '@/hooks/ipc-events/terminal-ui-routing-ipc-bridge'

import { drawTabsFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'

import { selectThread } from './thread-actions'
it.each(['editor', 'browser'] as const)(
  'honors represented %s IDs-only host focus over a draft',
  async (contentType) => {
    main.close()
    const tab = { ...ordinary, id: 'host-target', entityId: 'host-target', contentType }
    useAppStore.setState({
      unifiedTabsByWorktree: { [W]: [tab, first] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: first.id,
            tabOrder: [tab.id, first.id]
          })
        ]
      }
    })
    useAppStore.setState({
      openFiles:
        contentType === 'editor'
          ? [
              {
                id: tab.entityId,
                worktreeId: W,
                filePath: '/main/E',
                relativePath: 'E',
                language: 'text',
                isDirty: false,
                mode: 'edit'
              }
            ]
          : [],
      browserTabsByWorktree:
        contentType === 'browser'
          ? {
              [W]: [
                {
                  id: tab.entityId,
                  worktreeId: W,
                  title: 'Browser',
                  url: 'https://example.com',
                  pageOrder: [],
                  activePageId: null
                }
              ]
            }
          : {}
    })
    replaceMain(await drawTabsFromMain(useAppStore))
    setThreadTestPage({ selection: { kind: 'new', projectKey: 'local|repo', draftId: 'D' } })
    render(<Desktop />)
    const unsubs: (() => void)[] = []
    registerTerminalUiRoutingIpcBridge(unsubs)
    const focus = vi.mocked(window.api.ui.onFocusEditorTab).mock.calls[0][0]
    act(() => focus({ worktreeId: W, tabId: tab.id }))
    expect(screen.queryByText('Draft D')).toBeNull()
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(tab.id)
    unsubs.forEach((fn) => fn())
  }
)
it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(['phone-behind-draft', 'local-then-draft'] as const)(
  'settles actual pending content close without replacing a newer draft: %s',
  async (input) => {
    const { layoutApplyTestTransport } =
      await import('@/runtime/layout-apply-test-transport.test-fixture')
    const { isTabClosePending } = await import('@/runtime/layout-owner-pending-tabs')
    const { registerSessionTabIpcBridge } =
      await import('@/hooks/ipc-events/session-tab-ipc-bridge')
    main.close()
    const editor = { ...ordinary, id: 'E', entityId: '/main/E', contentType: 'editor' as const }
    useAppStore.setState({
      unifiedTabsByWorktree: { [W]: [editor, first] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: editor.id,
            tabOrder: [editor.id, first.id]
          })
        ]
      },
      openFiles: [
        {
          id: editor.entityId,
          worktreeId: W,
          filePath: editor.entityId,
          relativePath: 'E',
          language: 'text',
          isDirty: false
        }
      ],
      activeFileId: editor.entityId,
      activeFileIdByWorktree: { [W]: editor.entityId }
    })
    classify(first)
    replaceMain(await drawTabsFromMain(useAppStore))
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
    act(() => {
      if (input === 'phone-behind-draft') {
        setThreadTestPage({ selection: { kind: 'new', projectKey: 'local|repo', draftId: 'D' } })
      }
      if (input === 'phone-behind-draft') {
        requestClose({ requestId: 'phone-close', worktreeId: W, tabId: editor.id })
      } else {
        useAppStore.getState().closeFile(editor.entityId)
      }
    })
    expect(isTabClosePending(editor.id)).toBe(true)
    if (input === 'local-then-draft') {
      act(() =>
        setThreadTestPage({ selection: { kind: 'new', projectKey: 'local|repo', draftId: 'D' } })
      )
    }
    await act(async () => {
      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await main.settle()
    })
    expect(isTabClosePending(editor.id)).toBe(false)
    expect(useAppStore.getState().getTab(editor.id)).toBeNull()
    expect(screen.getByText('Draft D')).toBeTruthy()
    if (input === 'phone-behind-draft') {
      expect(respond).toHaveBeenCalledExactlyOnceWith({ requestId: 'phone-close' })
    }
    unsubs.forEach((stop) => stop())
  }
)

it('History commits its actual cross-workspace target before/after reveal', async () => {
  const otherW = 'other::/other'
  const other = { ...second, worktreeId: otherW, groupId: 'other-group' }
  useAppStore.setState({
    repos: [repo, { ...repo, id: 'other', path: '/other', displayName: 'Other' }],
    worktreesByRepo: {
      repo: [worktree],
      other: [
        makeWorktree({
          id: otherW,
          repoId: 'other',
          path: '/other',
          isMainWorktree: true,
          hostId: 'local'
        })
      ]
    },
    unifiedTabsByWorktree: { [W]: [ordinary, first], [otherW]: [other] },
    groupsByWorktree: {
      [W]: [
        makeTabGroup({
          id: 'g',
          worktreeId: W,
          activeTabId: first.id,
          tabOrder: [ordinary.id, first.id]
        })
      ],
      [otherW]: [
        makeTabGroup({
          id: 'other-group',
          worktreeId: otherW,
          activeTabId: other.id,
          tabOrder: [other.id]
        })
      ]
    },
    activeGroupIdByWorktree: { [W]: 'g', [otherW]: 'other-group' }
  })
  classify(other, { workspaceId: otherW })
  await act(async () => openNewThread())
  render(<Desktop />)
  await act(async () => {
    await activateAiVaultStructuredSession(
      { structuredSession: { workspaceId: otherW, sessionId: other.entityId, agent: 'codex' } },
      {
        activate: activateStructuredAgentSessionById,
        refresh: async () => {},
        reveal: async () => 'revealed',
        unavailable: vi.fn(),
        gone: vi.fn(),
        hostCannotOpen: vi.fn()
      },
      { kind: 'local' }
    )
  })
  expect(useAppStore.getState().activeWorktreeId).toBe(otherW)
  expect(useAppStore.getState().getActiveTab(otherW)?.id).toBe(other.id)
  expect(visibleConversation()).toEqual([other.entityId])
})
it.each([false, true])(
  'bounded History restore retains each caller claim (new same-target click=%s)',
  async (join) => {
    classify(first)
    classify(second)
    useAppStore.setState({ unifiedTabsByWorktree: { [W]: [ordinary, first] } })
    const deferred = Promise.withResolvers<void>()
    const deps = {
      activate: activateStructuredAgentSessionById,
      refresh: async () => deferred.promise,
      reveal: async () => 'revealed' as const,
      unavailable: vi.fn(),
      gone: vi.fn(),
      hostCannotOpen: vi.fn()
    }
    const target = {
      structuredSession: { workspaceId: W, sessionId: second.entityId, agent: 'codex' as const }
    }
    render(<Desktop />)
    const pending = activateAiVaultStructuredSession(target, deps, { kind: 'local' })
    await act(async () => openNewThread())
    const draftId = useThreadDraft.getState().draft!.draftId
    expect(screen.getByText(`Draft ${draftId}`)).toBeTruthy()
    const newer = join ? activateAiVaultStructuredSession(target, deps, { kind: 'local' }) : null
    await act(async () => {
      useAppStore.setState({ unifiedTabsByWorktree: { [W]: [ordinary, first, second] } })
      deferred.resolve()
      await pending
      await newer
    })
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(join ? second.id : first.id)
    if (join) {
      expect(visibleConversation()).toEqual([second.entityId])
    } else {
      expect(screen.getByText(`Draft ${draftId}`)).toBeTruthy()
    }
  }
)
it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(['browser', 'chat'] as const)(
  'ordinary flag-off delayed %s retains main completion selection',
  async (kind) => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
    })
    render(<Desktop />)
    let id = ''
    act(() => {
      if (kind === 'browser') {
        const created = useAppStore.getState().createBrowserTab(W, 'https://example.com', {
          validateLinkPlacement: () => {},
          focusAddressBar: false
        })
        id = created.id
      } else {
        id = openStructuredAgentSessionProvisionalTab({
          worktreeId: W,
          executionHostId: 'local',
          sessionId: 'delayed-chat',
          agent: 'codex'
        }).id
      }
      navigateDesktopTab(ordinary.id)
    })
    await act(async () => main.settle())
    const target =
      kind === 'browser'
        ? useAppStore.getState().unifiedTabsByWorktree[W].find((tab) => tab.entityId === id)!
        : useAppStore.getState().getTab(id)!
    expect(target).toBeTruthy()
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(target.id)
    expect(screen.getByTestId('strip-g').dataset.active).toBe(target.id)
  }
)
it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(['draft', 'empty', 'live', 'ABA', 'off-on-off'] as const)(
  'old ordinary publication settles behind newer experimental %s',
  async (kind) => {
    classify(first)
    classify(second)
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
    })
    render(<Desktop />)
    let browser: ReturnType<ReturnType<typeof useAppStore.getState>['createBrowserTab']>
    act(() => {
      browser = useAppStore.getState().createBrowserTab(W, 'https://example.com', {
        validateLinkPlacement: () => {},
        focusAddressBar: false
      })
    })
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: true }
      })
    )
    if (kind === 'draft' || kind === 'off-on-off') {
      await act(async () => openNewThread())
    } else if (kind === 'empty') {
      act(() => {
        // Explicitly opening a thread-only focused group requests the empty ordinary workbench.
        useAppStore.setState({
          groupsByWorktree: {
            [W]: [
              makeTabGroup({
                id: 'g',
                worktreeId: W,
                activeTabId: first.id,
                tabOrder: [first.id, second.id]
              })
            ]
          }
        })
        activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
      })
    } else {
      act(() => {
        selectThread(second)
        if (kind === 'ABA') {
          selectThread(first)
          selectThread(second)
        }
      })
    }
    if (kind === 'off-on-off') {
      act(() => {
        useAppStore.setState({
          settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
        })
        navigateDesktopTab(ordinary.id)
      })
    }
    const route = useAppStore.getState().activeView
    const selected = useAppStore.getState().getActiveTab(W)?.id
    await act(async () => main.settle())
    expect(
      useAppStore.getState().unifiedTabsByWorktree[W].some((tab) => tab.entityId === browser!.id)
    ).toBe(true)
    expect(useAppStore.getState().activeView).toBe(route)
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(selected)
    if (kind === 'live' || kind === 'ABA') {
      expect(visibleConversation()).toEqual([second.entityId])
    }
    if (kind === 'draft') {
      expect(screen.getByText(`Draft ${useThreadDraft.getState().draft!.draftId}`)).toBeTruthy()
    }
  }
)

it
  .runIf(ORCA_LAYOUT_OWNER_IS_MAIN)
  .each(['draft-settings', 'ordinary-settings', 'ordinary-activity'] as const)(
  'publishes a held destination under the foreground app section: %s',
  async (input) => {
    if (input === 'draft-settings') {
      await act(async () => openNewThread())
    } else {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
      })
    }
    render(<Desktop />)
    let browserId = ''
    act(() => {
      browserId = useAppStore.getState().createBrowserTab(W, 'https://example.com').id
      if (input === 'ordinary-activity') {
        useAppStore.getState().openActivityPage()
      } else {
        useAppStore.getState().openSettingsPage()
      }
    })
    await act(async () => main.settle())
    const target = useAppStore
      .getState()
      .unifiedTabsByWorktree[W].find((tab) => tab.entityId === browserId)!
    expect(target).toBeTruthy()
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(target.id)
    expect(useAppStore.getState().activeView).toBe(
      input === 'ordinary-activity' ? 'activity' : 'settings'
    )
    expect(screen.queryByTestId('strip-g')).toBeNull()
    if (input !== 'ordinary-activity') {
      act(() => useAppStore.getState().closeSettingsPage())
      expect(useAppStore.getState().activeView).toBe('terminal')
      expect(screen.getByTestId('strip-g').dataset.active).toBe(target.id)
    }
  }
)
