// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
const mocks = vi.hoisted(() => ({ supported: true, start: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => mocks.supported
}))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.start
}))
vi.mock('@/lib/structured-agent-session-launch-surface', () => ({
  captureStructuredLaunchSurfaceAddress: () => ({
    worktreeId: 'folder:workspace',
    precedingTabIds: []
  })
}))
vi.mock('@/lib/agent-launch-request-id', () => ({ newAgentLaunchRequestId: () => 'request' }))
import { useNativeChatFork } from './use-native-chat-fork'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.supported = true
})
const items: AgentJournalRenderItem[] = [
  {
    itemId: 'turn-B',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'turn-B', state: 'completed', outcome: 'success' }
  },
  {
    itemId: 'answer-B',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'turn', turnItemId: 'turn-B' },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'B' }] }
  }
]
const input = {
  pane: {
    agent: 'codex' as const,
    sessionId: 'parent',
    target: { kind: 'local' as const },
    groupId: 'group'
  },
  worktreeId: 'folder:workspace',
  epoch: 'epoch-1',
  items,
  ready: true
}

describe('useNativeChatFork', () => {
  it('uses the parent host and cut identity, coalescing clicks while create is pending', async () => {
    let complete = () => {}
    mocks.start.mockReturnValue({
      launchResult: new Promise<void>((resolve) => {
        complete = resolve
      })
    })
    const view = renderHook(() => useNativeChatFork(input))
    let done: Promise<void> | undefined
    act(() => {
      done = view.result.current.surface!.request('answer-B')
      void view.result.current.surface!.request('answer-B')
    })
    expect(view.result.current.surface?.pending).toBe(true)
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('folder:workspace', 'codex', {
      requestId: 'request',
      executionHostId: 'local',
      forkFrom: { sessionId: 'parent', itemId: 'answer-B', expectedEpoch: 'epoch-1' },
      surfaceAddress: { worktreeId: 'folder:workspace', precedingTabIds: [] }
    })
    await act(async () => {
      complete()
      await done
    })
    expect(view.result.current.surface?.pending).toBe(false)
  })

  it('offers no action for Claude or unverified/older hosts', () => {
    expect(
      renderHook(() => useNativeChatFork({ ...input, pane: { ...input.pane, agent: 'claude' } }))
        .result.current.surface
    ).toBeUndefined()
    mocks.supported = false
    expect(renderHook(() => useNativeChatFork(input)).result.current.surface).toBeUndefined()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('shows an unknown result without claiming no child was created', async () => {
    mocks.start.mockReturnValue({
      launchResult: Promise.reject(
        new Error('The branch may have been created. Check its chat before retrying.')
      )
    })
    const view = renderHook(() => useNativeChatFork(input))
    await act(() => view.result.current.surface!.request('answer-B'))
    expect(view.result.current.error).toContain('may have been created')
    expect(view.result.current.surface?.pending).toBe(false)
  })
})
