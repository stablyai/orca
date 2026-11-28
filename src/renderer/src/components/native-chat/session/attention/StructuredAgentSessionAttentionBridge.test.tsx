// @vitest-environment happy-dom
// A chat worker's finish raises no unread and has no PTY, so it must stamp Recent itself (#50660).
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type { StructuredAgentSessionTurnCompletionListener } from '@/runtime/native-chat/status/structured-agent-session-turn-completion-feed'
import {
  chatPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'

const listeners = new Set<StructuredAgentSessionTurnCompletionListener>()
vi.mock('@/runtime/native-chat/status/structured-agent-session-turn-completion-feed', () => ({
  getStructuredAgentSessionTurnCompletionFeed: () => ({
    activate: () => () => {},
    subscribe: (listener: StructuredAgentSessionTurnCompletionListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
}))
// Delivery is the OS notification IPC.
vi.mock('@/attention/agent-attention-notification-delivery', () => ({
  deliverAgentAttentionNotification: () => {},
  readAgentAttentionNotificationSound: () => undefined
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function complete(sessionId: string, completedAt: number): void {
  for (const listener of listeners) {
    listener({
      type: 'completion',
      completion: {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'repo::/a',
          workspaceKind: 'git-worktree'
        },
        sessionId,
        turnId: `turn-${completedAt}`,
        outcome: 'success',
        completedAt
      }
    })
  }
}

function mountWorker(executionHostId: ExecutionHostId): () => number | undefined {
  const worker = makeStructuredChatTab({
    id: structuredAgentSessionTabId('worker-session'),
    entityId: 'worker-session',
    worktreeId: 'repo::/a',
    executionHostId
  })
  const contexts = {
    [chatPaneKey(worker.entityId)]: {
      taskId: 'task',
      dispatchId: 'dispatch',
      parentPaneKey: 'coordinator-pane'
    }
  }
  useAppStore.setState({
    activeWorktreeId: 'repo::/b',
    worktreesByRepo: {
      repo: [
        makeWorktree({ id: 'repo::/a', repoId: 'repo', lastActivityAt: 1 }),
        makeWorktree({ id: 'repo::/b', repoId: 'repo', lastActivityAt: 2 })
      ]
    },
    unifiedTabsByWorktree: {
      'repo::/a': [worker]
    },
    runtimeAgentOrchestrationByPaneKey: {},
    remoteAgentOrchestrationByHost: {}
  })
  // Through the store action, so a host's worker context lands in that host's map as it does live.
  useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(contexts, executionHostId)
  render(<StructuredAgentSessionAttentionBridge />)
  return () =>
    useAppStore.getState().worktreesByRepo.repo?.find((w) => w.id === 'repo::/a')?.lastActivityAt
}

it("stamps a dispatched chat worker's workspace when it finishes, once per window", () => {
  vi.useFakeTimers({ now: 1_000_000 })
  const readStamp = mountWorker('local')
  const sortEpoch = useAppStore.getState().sortEpoch

  act(() => complete('other-session', 1))
  expect(readStamp()).toBe(1)

  act(() => complete('worker-session', 1))
  expect(readStamp()).toBe(1_000_000)
  expect(useAppStore.getState().sortEpoch).toBe(sortEpoch + 1)

  vi.setSystemTime(1_005_000)
  act(() => complete('worker-session', 2))
  expect(readStamp()).toBe(1_000_000)
  expect(useAppStore.getState().sortEpoch).toBe(sortEpoch + 1)
})

it('leaves an environment-owned worker to its owning host', () => {
  vi.useFakeTimers({ now: 1_000_000 })
  const readStamp = mountWorker(toRuntimeExecutionHostId('env-1'))

  act(() => complete('worker-session', 1))
  expect(readStamp()).toBe(1)
})
