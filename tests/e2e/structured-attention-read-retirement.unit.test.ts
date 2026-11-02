// @vitest-environment happy-dom
// Register preload/store seams before importing their consumers.
import {
  fixture,
  transport,
  WORKSPACE,
  SUBJECT,
  SCOPE,
  NOTIFICATION_SETTINGS,
  addPrompt,
  AttentionPolicy,
  dismissIds,
  publishView,
  readCalls,
  TAB,
  ReadSurface
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement, StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, describe } from 'vitest'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import {
  agentSessionAttentionSubjectPrefix,
  agentSessionPromptAttentionKey
} from '../../src/shared/agent-session-attention'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import {
  projectStructuredAgentSessionStatusState,
  structuredAgentSessionPaneKey
} from '../../src/shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import { createStructuredAttentionMobileDelivery } from '../../src/main/runtime/structured-agent-session-mobile-attention'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { useStructuredAgentSessionRead } from '@/components/native-chat/use-structured-agent-session-read'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StructuredNotificationRead } from '../../src/shared/notification-settings-types'
import { RuntimeMobileNotificationController } from '../../src/main/runtime/runtime-mobile-notification-controller'

describe('Explicit desktop read acknowledgements', () => {
  const TARGET = { kind: 'local' } as const

  function Transcript({ visible }: { visible: boolean }): null {
    useStructuredAgentSessionRead({
      sessionId: SESSION,
      target: TARGET,
      isVisible: visible,
      isViewed: visible
    })
    return null
  }

  function bridge(visible?: boolean) {
    return createElement(
      Fragment,
      null,
      createElement(StructuredAgentSessionAttentionBridge),
      createElement(AttentionPolicy),
      ...(visible === undefined ? [] : [createElement(Transcript, { visible })])
    )
  }

  function settleTurn(): void {
    fixture.items = fixture.items.map((item): AgentJournalRenderItem =>
      item.body.kind === 'turn'
        ? {
            ...item,
            revision: item.revision + 1,
            body: { ...item.body, state: 'completed', outcome: 'success' }
          }
        : item
    )
    fixture.sequence += 1
    fixture.hostFeed.observe(SESSION)
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {})
    }
  }

  const promptKey = (id: string) => agentSessionPromptAttentionKey(SCOPE, SESSION, id)

  it('Mark read on a chat never opened withdraws the prompt alert it surfaced', async () => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    render(bridge())
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(1))
    act(() => useAppStore.getState().acknowledgeAgents([SUBJECT], undefined, 'explicit'))
    await flush()
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
    expect(dismissIds()).toEqual([promptKey('A')])
  })

  it('Mark read on a chat never opened withdraws its completion alert, as before prompt alerts', async () => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    render(bridge())
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => settleTurn())
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(1))
    act(() => useAppStore.getState().acknowledgeAgents([SUBJECT], undefined, 'explicit'))
    await flush()
    expect(dismissIds()).toEqual([
      `${agentSessionAttentionSubjectPrefix(SCOPE, SESSION)}turn:turn-1`
    ])
  })

  it('Mark read on a chat hidden since an earlier view covers the newer prompt it surfaced', async () => {
    const screen = render(bridge(true))
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
    screen.rerender(bridge(false))
    await flush()
    transport.dispatch.mockClear()
    act(() => addPrompt('B'))
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(1))
    act(() => useAppStore.getState().acknowledgeAgents([SUBJECT], undefined, 'explicit'))
    await flush()
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
    expect(dismissIds()).toEqual([promptKey('A'), promptKey('B')])
  })

  it('Mark read never covers a prompt raised after the click', async () => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    render(bridge())
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(1))
    act(() => {
      useAppStore.getState().acknowledgeAgents([SUBJECT], undefined, 'explicit')
      addPrompt('B')
    })
    await flush()
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
    expect(dismissIds()).toEqual([promptKey('A')])
  })

  it('Mark all read covers every chat it marks, viewed earlier or never opened', async () => {
    const OTHER = 'session-beta'
    const otherSubject = structuredAgentSessionPaneKey('chat-2', OTHER)
    useAppStore.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          ...(useAppStore.getState().unifiedTabsByWorktree[WORKSPACE] ?? []),
          makeUnifiedTab({
            id: 'chat-2',
            worktreeId: WORKSPACE,
            groupId: 'group',
            contentType: 'agent-session',
            entityId: OTHER,
            agentSessionAgent: 'claude'
          })
        ]
      }
    })
    // The second chat's host side: its own journal, the same phone delivery and renderer stream.
    let otherItems = fixture.items.map((item) => ({ ...item }))
    let otherSequence = fixture.sequence
    const otherFeed = new StructuredAgentSessionTurnCompletionFeed({
      sessions: new Map([
        [
          OTHER,
          {
            journal: { cursor: () => ({ epoch: 'journal-b', sequence: otherSequence }) },
            params: { location: SCOPE }
          }
        ]
      ]),
      readStatusState: () => projectStructuredAgentSessionStatusState(otherItems),
      now: () => 42
    })
    const delivery = createStructuredAttentionMobileDelivery({
      readNotificationSettings: () => ({ ...NOTIFICATION_SETTINGS, suppressWhenFocused: false }),
      readWorkspaceLabels: () => ({}),
      isWorkspaceHidden: () => false,
      dispatch: (event) => fixture.controller.dispatch(event),
      reconcile: (state) => fixture.controller.reconcileStructuredPromptAttention(state),
      now: () => 42
    })
    otherFeed.subscribe({
      id: 'other',
      includePrompts: true,
      emit: (event) => {
        if (event.type !== 'end') {
          delivery.deliver(event, undefined)
          fixture.completion?.({
            id: 'completion',
            ok: true,
            _meta: { runtimeId: 'h' },
            result: event
          })
        }
      }
    })
    otherFeed.observe(OTHER)
    const screen = render(bridge(true))
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
    screen.rerender(bridge(false))
    await flush()
    transport.dispatch.mockClear()
    act(() => {
      addPrompt('B')
      const promptB = fixture.items.find((item) => item.itemId === 'B')
      if (!promptB) {
        throw new Error('prompt B missing')
      }
      otherItems = [...otherItems, { ...promptB, itemId: 'C', sequence: ++otherSequence }]
      otherFeed.observe(OTHER)
    })
    await waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(2))
    act(() =>
      useAppStore.getState().acknowledgeAgents([SUBJECT, otherSubject], undefined, 'explicit')
    )
    await flush()
    expect(dismissIds()).toEqual([
      promptKey('A'),
      promptKey('B'),
      agentSessionPromptAttentionKey(SCOPE, OTHER, 'C')
    ])
  })
})

describe('Viewed structured session owner lifecycle', () => {
  const PROMPT_A = agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')
  // Memoized like the pane's own target, so a rerender keeps the owner it already holds.
  const LOCAL: RuntimeClientTarget = { kind: 'local' }

  /** The chat pane's read: shown means visible and viewed, as the transport derives both. */
  function Pane({ shown, target }: { shown: boolean; target: RuntimeClientTarget }): null {
    useStructuredAgentSessionRead({ sessionId: SESSION, target, isVisible: shown, isViewed: shown })
    return null
  }

  function tree(options: {
    shown: boolean
    paneKey?: string
    strict?: boolean
    target?: RuntimeClientTarget
  }) {
    const inner = createElement(
      Fragment,
      null,
      createElement(StructuredAgentSessionAttentionBridge),
      createElement(AttentionPolicy),
      createElement(Pane, {
        key: options.paneKey ?? 'pane',
        shown: options.shown,
        target: options.target ?? LOCAL
      })
    )
    return options.strict ? createElement(StrictMode, null, inner) : inner
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }

  /** A prompt raised while the user is elsewhere and the pane is hidden. */
  async function promptWhileAway(options: { strict?: boolean } = {}) {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    const screen = render(tree({ shown: false, strict: options.strict }))
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await settle()
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
    return screen
  }

  /** The user opens the chat: the pane reads its history and views it. */
  async function show(rerender: () => void): Promise<void> {
    fixture.hydrate = undefined
    act(() => useAppStore.getState().setActiveWorktree(WORKSPACE))
    rerender()
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    await settle()
  }

  function expectViewReadWithdraws(): void {
    expect(findStructuredAgentSessionReadOwner(SESSION, LOCAL)).toBeDefined()
    expect(readCalls()).toBeGreaterThan(0)
    expect(dismissIds()).toContain(PROMPT_A)
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
  }

  it('a view read under StrictMode still finds its owner and withdraws the alert', async () => {
    const screen = await promptWhileAway({ strict: true })
    await show(() => screen.rerender(tree({ shown: true, strict: true })))
    expectViewReadWithdraws()
  })

  it('a pane hidden by a worktree switch and shown again withdraws on view', async () => {
    const screen = await promptWhileAway()
    await show(() => screen.rerender(tree({ shown: true })))
    expect(dismissIds()).toContain(PROMPT_A)
    act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
    screen.rerender(tree({ shown: false }))
    await settle()
    act(() => addPrompt('B'))
    await settle()
    // An owner that already holds history resumes its journal stream instead of re-reading it.
    act(() => useAppStore.getState().setActiveWorktree(WORKSPACE))
    screen.rerender(tree({ shown: true }))
    await settle()
    act(() => publishView())
    await settle()
    expectViewReadWithdraws()
    expect(dismissIds()).toContain(agentSessionPromptAttentionKey(SCOPE, SESSION, 'B'))
  })

  it('a pane remounted in one commit (a tab move) keeps its owner findable', async () => {
    const screen = await promptWhileAway()
    // The new instance reads the still-held owner before the old one's cleanup releases it.
    screen.rerender(tree({ shown: false, paneKey: 'moved' }))
    await settle()
    await show(() => screen.rerender(tree({ shown: true, paneKey: 'moved' })))
    expectViewReadWithdraws()
  })

  it('a new target object for the same host keeps the owner findable', async () => {
    const screen = await promptWhileAway()
    screen.rerender(tree({ shown: false, target: { kind: 'local' } }))
    await settle()
    await show(() => screen.rerender(tree({ shown: true, target: { kind: 'local' } })))
    expectViewReadWithdraws()
  })
})

describe('Accepted structured history read retirement', () => {
  it('reads the first accepted history even after local unread and clock targets were cleared', async () => {
    addPrompt('A')
    render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: true })
      )
    )
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    expect(readCalls()).toBe(0)
    expect(useAppStore.getState().unreadAgentCompletionPanes).toEqual({})
    await act(async () => fixture.hydrate?.())
    await waitFor(() =>
      expect(dismissIds()).toEqual([agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')])
    )
    expect(readCalls()).toBe(1)
  })

  it('reads B on return while A keeps the already-read row clock unchanged', async () => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    useAppStore
      .getState()
      .setAgentStatus(
        SUBJECT,
        { state: 'blocked', prompt: 'Work', agentType: 'claude' },
        'Chat',
        { updatedAt: 1000, stateStartedAt: 1000 },
        { tabId: TAB, worktreeId: WORKSPACE }
      )
    const screen = render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: false })
      )
    )
    await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
    act(() => addPrompt('A'))
    await act(async () => fixture.hydrate?.())
    await waitFor(() => expect(fixture.journal).toBeTypeOf('function'))
    act(() => useAppStore.getState().acknowledgeAgents([SUBJECT]))
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    const stamp = useAppStore.getState().acknowledgedAgentsByPaneKey[SUBJECT]
    act(() => {
      addPrompt('B')
      publishView()
    })
    expect(dismissIds()).toHaveLength(1)
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
    act(() => useAppStore.setState({ activeWorktreeId: WORKSPACE }))
    screen.rerender(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: true })
      )
    )
    await waitFor(() =>
      expect(dismissIds()).toEqual(
        ['A', 'B'].map((id) => agentSessionPromptAttentionKey(SCOPE, SESSION, id))
      )
    )
    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[SUBJECT]).toBe(stamp)
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
    expect(readCalls()).toBe(2)
  })

  it('reads a newly accepted visible prompt without sending an RPC for text-only updates', async () => {
    addPrompt('A')
    render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: true })
      )
    )
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    await waitFor(() => expect(readCalls()).toBe(1))
    act(() => {
      addPrompt('B')
      publishView()
    })
    await waitFor(() => expect(dismissIds()).toHaveLength(2))
    const calls = readCalls()
    act(() => {
      fixture.items = [
        ...fixture.items,
        {
          itemId: 'text',
          revision: 1,
          sequence: ++fixture.sequence,
          observedAt: fixture.sequence,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'More output' }]
          }
        }
      ]
      publishView()
    })
    await act(async () => {})
    expect(readCalls()).toBe(calls)
  })

  it('keeps hydration unread while away and retries the read on presence return', async () => {
    transport.away.mockResolvedValue(true)
    addPrompt('A')
    render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: true })
      )
    )
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    expect(readCalls()).toBe(0)
    transport.away.mockResolvedValue(false)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
  })

  it.each(['transport-error', 'false-result'] as const)(
    'retries a remote %s on a later read with the existing presence gate',
    async (failure) => {
      const target = { kind: 'environment', environmentId: 'retry-host' } as const
      const tab = useAppStore.getState().unifiedTabsByWorktree[WORKSPACE]?.[0]
      if (!tab) {
        throw new Error('chat tab missing')
      }
      useAppStore.setState({
        unifiedTabsByWorktree: { [WORKSPACE]: [{ ...tab, executionHostId: 'runtime:retry-host' }] }
      })
      addPrompt('A')
      const original = transport.call.getMockImplementation()
      let failed = false
      transport.call.mockImplementation(async (...args) => {
        if (args[1] === 'agentSession.acknowledgeAttention' && !failed) {
          failed = true
          if (failure === 'transport-error') {
            throw new Error('scripted transient transport failure')
          }
          return { acknowledged: false }
        }
        return original?.(...args)
      })
      render(
        createElement(
          Fragment,
          null,
          createElement(StructuredAgentSessionAttentionBridge),
          createElement(AttentionPolicy),
          createElement(ReadSurface, { viewed: true, target: target })
        )
      )
      await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
      await act(async () => fixture.hydrate?.())
      expect(readCalls()).toBe(1)
      expect(dismissIds()).toEqual([])
      await act(async () => {})
      expect(readCalls()).toBe(1)
      if (failure === 'transport-error') {
        await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
      } else {
        transport.away.mockResolvedValue(true)
        await act(async () => window.dispatchEvent(new Event('focus')))
        expect(readCalls()).toBe(1)
        transport.away.mockResolvedValue(false)
        await act(async () => window.dispatchEvent(new Event('focus')))
      }
      await waitFor(() =>
        expect(dismissIds()).toEqual([agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')])
      )
      expect(readCalls()).toBe(2)
      expect(
        transport.call.mock.calls
          .filter(([, method]) => method === 'agentSession.acknowledgeAttention')
          .map(([owner]) => owner)
      ).toEqual([target, target])
    }
  )

  it('retries a failed local desktop relay withdrawal on a later explicit read', async () => {
    const relayDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-read-retry-'))
    const relay = new RuntimeMobileNotificationController()
    try {
      addPrompt('A')
      const sent = fixture.events.find((event) => event.type === 'notification')
      if (!sent?.notificationId || sent.type !== 'notification') {
        throw new Error('prompt not sent')
      }
      relay.configureDismissalStore(relayDirectory)
      relay.dispatch(sent)
      const withdrawals: string[] = []
      relay.onDispatched((event) => {
        if (event.type === 'dismiss') {
          withdrawals.push(event.notificationId)
        }
      })
      transport.dismiss
        .mockImplementation(async (_ids, _panes, reads?: StructuredNotificationRead[]) => {
          for (const read of reads ?? []) {
            relay.retireStructuredAttention(read)
          }
          return { dismissed: 0 }
        })
        .mockRejectedValueOnce(new Error('scripted local retirement failure'))
      render(
        createElement(
          Fragment,
          null,
          createElement(StructuredAgentSessionAttentionBridge),
          createElement(AttentionPolicy),
          createElement(ReadSurface, { viewed: true })
        )
      )
      await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
      await act(async () => fixture.hydrate?.())
      expect(dismissIds()).toHaveLength(1)
      expect(withdrawals).toEqual([])
      await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
      await waitFor(() => expect(withdrawals).toEqual([sent.notificationId]))
      expect(
        transport.dismiss.mock.calls.filter(([, , reads]) => Array.isArray(reads))
      ).toHaveLength(2)
    } finally {
      await relay.closeDismissals()
      rmSync(relayDirectory, { recursive: true, force: true })
    }
  })

  it('an older failed attempt cannot erase a newer success when the observation returns to A', async () => {
    addPrompt('A')
    const original = transport.call.getMockImplementation()
    let release: (() => void) | undefined
    let first = true
    transport.call.mockImplementation(async (...args) => {
      if (args[1] === 'agentSession.acknowledgeAttention' && first) {
        first = false
        return await new Promise((resolve) => {
          release = () => resolve({ acknowledged: false })
        })
      }
      return original?.(...args)
    })
    render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(AttentionPolicy),
        createElement(ReadSurface, { viewed: true })
      )
    )
    await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
    await act(async () => fixture.hydrate?.())
    expect(readCalls()).toBe(1)
    act(() => useAppStore.getState().acknowledgeAgents([SUBJECT]))
    expect(readCalls()).toBe(1)
    act(() => {
      addPrompt('B')
      publishView()
    })
    await waitFor(() => expect(readCalls()).toBe(2))
    await act(async () => {})
    act(() => {
      fixture.items = fixture.items.map((item): AgentJournalRenderItem =>
        item.itemId === 'B' && item.body.kind === 'approval'
          ? {
              ...item,
              revision: item.revision + 1,
              body: { ...item.body, resolution: { ...item.body.resolution, state: 'resolved' } }
            }
          : item
      )
      fixture.sequence += 1
      fixture.hostFeed.observe(SESSION)
      publishView()
    })
    await waitFor(() => expect(readCalls()).toBe(3))
    await act(async () => release?.())
    await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
    expect(readCalls()).toBe(3)
    expect(dismissIds()).toHaveLength(2)
  })
})
