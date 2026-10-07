// @vitest-environment happy-dom
// Register preload/store seams before importing their consumers.
import {
  fixture,
  transport,
  WORKSPACE,
  TAB,
  SUBJECT,
  SCOPE,
  addPrompt,
  publishView,
  ReadSurface,
  AttentionPolicy,
  readCalls,
  dismissIds
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StructuredNotificationRead } from '../../src/shared/notification-settings-types'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import { agentSessionPromptAttentionKey } from '../../src/shared/agent-session-attention'
import { RuntimeMobileNotificationController } from '../../src/main/runtime/runtime-mobile-notification-controller'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'

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
  try {
    addPrompt('A')
    const sent = fixture.events.find((event) => event.type === 'notification')
    if (!sent?.notificationId || sent.type !== 'notification') {
      throw new Error('prompt not sent')
    }
    const relay = new RuntimeMobileNotificationController()
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
    expect(transport.dismiss.mock.calls.filter(([, , reads]) => Array.isArray(reads))).toHaveLength(
      2
    )
  } finally {
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
