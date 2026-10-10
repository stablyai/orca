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
  dismissIds
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
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
  expect(dismissIds()).toEqual([`${agentSessionAttentionSubjectPrefix(SCOPE, SESSION)}turn:turn-1`])
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
