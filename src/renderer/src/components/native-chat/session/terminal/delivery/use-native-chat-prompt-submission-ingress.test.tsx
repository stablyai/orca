// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { act, render as renderComponent, renderHook, cleanup } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from './native-chat-pending'
import * as promptObservation from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'
import { useAppStore } from '@/store/index'
import { createAgentStatusEventApplicator } from '@/hooks/ipc-events/agent-status-event-applicator'
import type { AgentStatusIpcPayload } from '../../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { NativeChatPromptSubmission } from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'
import { makePaneKey } from '../../../../../../../shared/workspace-layout/stable-pane-id'
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
  useAppStore.setState({ agentStatusByPaneKey: {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([100, 1000])(
  'publishes only genuine receipt changes to %i mounted chat consumers through IPC ingress',
  (size) => {
    const worktreeId = 'repo::/prompt-history'
    const tabs = ['receipt-owner', 'receipt-other']
    const leaves = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const paneKeys = tabs.map((tab, index) => makePaneKey(tab, leaves[index]))
    const before = useAppStore.getState()
    useAppStore.setState({
      workspaceSessionReady: true,
      tabsByWorktree: {
        [worktreeId]: tabs.map((id, index) => ({
          id,
          ptyId: `pty-${id}`,
          worktreeId,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: 0
        }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab, index) => [
          tab,
          {
            root: { type: 'leaf' as const, leafId: leaves[index] },
            activeLeafId: leaves[index],
            expandedLeafId: null
          }
        ])
      )
    })
    const enqueue = vi.fn()
    const apply = createAgentStatusEventApplicator({
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: enqueue
    })
    const projectHistory = vi.spyOn(promptObservation, 'reuseNativeChatPromptSubmissions')
    let clock = Date.now()
    let history: readonly NativeChatPromptSubmission[] = [
      {
        sessionId: 'session',
        textDigest: 'a'.repeat(64),
        connectionId: null,
        process: { pid: 42, platform: 'linux', startTime: '1' },
        observation: {
          origin: 'hook',
          authorityId: 'host',
          incarnation: 1,
          revision: 1,
          observedAt: 1
        }
      }
    ]
    function publish(paneKey: string, submissions = history): void {
      const payload: AgentStatusIpcPayload = {
        paneKey,
        worktreeId,
        connectionId: null,
        state: 'working',
        agentType: 'claude',
        prompt: 'current turn',
        receivedAt: ++clock,
        stateStartedAt: 1,
        promptSubmissions: structuredClone(submissions)
      }
      projectHistory.mockClear()
      expect(apply(payload)).toBe('applied')
      expect(projectHistory).toHaveBeenCalledTimes(1)
    }
    publish(paneKeys[0])
    const renders = Array.from({ length: size }, () => 0)
    const session = { messages: [] }
    function Consumer({ index }: { index: number }) {
      useNativeChatPendingDelivery({
        paneKey: index === 0 ? paneKeys[0] : `chat-${index}`,
        agent: 'claude',
        session
      })
      renders[index]++
      return null
    }
    const mounted = renderComponent(
      createElement(
        Fragment,
        null,
        renders.map((_, index) => createElement(Consumer, { key: index, index }))
      )
    )
    try {
      renders.fill(0)
      const initial = useAppStore.getState().agentStatusByPaneKey[paneKeys[0]].promptSubmissions
      act(() => publish(paneKeys[0]))
      expect(useAppStore.getState().agentStatusByPaneKey[paneKeys[0]].promptSubmissions).toBe(
        initial
      )
      expect(renders.every((count) => count === 0)).toBe(true)
      act(() => publish(paneKeys[1]))
      expect(renders.every((count) => count === 0)).toBe(true)
      const changes: ((entry: NativeChatPromptSubmission) => NativeChatPromptSubmission)[] = [
        (entry) => ({
          ...entry,
          textDigest: 'b'.repeat(64),
          observation: { ...entry.observation, revision: 2 }
        }),
        (entry) => ({ ...entry, process: { ...entry.process, startTime: '2' } }),
        (entry) => ({ ...entry, sessionId: 'replacement-session' }),
        (entry) => ({ ...entry, connectionId: 'replacement-connection' })
      ]
      for (const change of changes) {
        renders.fill(0)
        history = [change(history[0])]
        const previous = useAppStore.getState().agentStatusByPaneKey[paneKeys[0]].promptSubmissions
        act(() => publish(paneKeys[0]))
        expect(useAppStore.getState().agentStatusByPaneKey[paneKeys[0]].promptSubmissions).not.toBe(
          previous
        )
        expect(renders[0]).toBe(1)
        expect(renders.slice(1).every((count) => count === 0)).toBe(true)
        renders.fill(0)
        act(() => publish(paneKeys[0]))
        expect(renders.every((count) => count === 0)).toBe(true)
      }
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
      useAppStore.setState({
        workspaceSessionReady: before.workspaceSessionReady,
        tabsByWorktree: before.tabsByWorktree,
        terminalLayoutsByTabId: before.terminalLayoutsByTabId
      })
    }
  }
)

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [],
  timestamp: null,
  source: 'transcript'
}
const args = { paneKey: 'pane', agent: 'claude' as const }
function sourceRow(text: string, id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript',
    inputContent: {
      provider: 'opencode',
      textDigest: createHash('sha256').update(text).digest('hex'),
      images: []
    }
  }
}
it('uses a late binding with unchanged history and rows when the original dispatch finishes', async () => {
  const completion = Promise.withResolvers<'submitted'>()
  const submission: NativeChatPromptSubmission = {
    sessionId: 'session',
    textDigest: createHash('sha256').update('repeat').digest('hex'),
    connectionId: null,
    process: { pid: 42, platform: 'linux', startTime: '1' },
    observation: { origin: 'hook', authorityId: 'host', incarnation: 1, revision: 2, observedAt: 1 }
  }
  const context = {
    owner: 'read',
    sessionId: 'session',
    targetPtyId: 'pty',
    runtimeEnvironmentId: null
  }
  const generation = Symbol('read')
  const mounted = renderHook(
    ({ messages }) =>
      useNativeChatPendingDelivery({
        ...args,
        session: {
          messages,
          readPhase: 'ready',
          sessionId: 'session',
          sourceObservation: { messages, generation, context }
        }
      }),
    { initialProps: { messages: [boundary] } }
  )
  let id = ''
  act(() => {
    const cancelled = mounted.result.current.record('repeat', undefined, false, 'claude')
    id = mounted.result.current.record('repeat', undefined, false, 'claude', completion.promise)
    mounted.result.current.cancel(cancelled, true)
  })
  const source = sourceRow('repeat', 'receipt')
  mounted.rerender({
    messages: [
      boundary,
      {
        ...source,
        inputContent: {
          provider: 'claude',
          textDigest: submission.textDigest,
          images: [],
          retained: true
        }
      },
      { ...boundary, id: 'reply' }
    ]
  })
  act(() =>
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        pane: {
          paneKey: 'pane',
          state: 'working',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          promptSubmissions: [submission]
        }
      }
    }))
  )
  expect(mounted.result.current.pending.map((entry) => entry.id)).toEqual([id])
  act(() =>
    mounted.result.current.setPromptBinding(id, {
      runtimeId: 'host',
      ptyId: 'pty',
      generation: 1,
      processIncarnation: 'pty:1',
      terminalHandle: 'terminal',
      targetPtyId: 'pty',
      runtimeEnvironmentId: null,
      rootBaseline: { ...submission, observation: { ...submission.observation, revision: 1 } }
    })
  )
  await act(async () => {
    completion.resolve('submitted')
    await completion.promise
  })
  expect(mounted.result.current.pending).toEqual([])
})
