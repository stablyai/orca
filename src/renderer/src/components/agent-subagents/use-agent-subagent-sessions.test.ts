// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentSubagentSessions } from './use-agent-subagent-sessions'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))
const target = { kind: 'environment', environmentId: 'remote-account' } as const
const child = {
  id: 'child',
  sessionId: 'child',
  title: 'Reviewer',
  filePath: '/remote/child.jsonl',
  agent: 'codex',
  subagent: { status: 'completed' }
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  call.mockReset()
})

it('loads machine children on their owning host without a parent transcript path', async () => {
  call.mockResolvedValue({ sessions: [child] })
  const { result } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'codex',
      parentFilePath: null,
      structuredSessionId: 'machine-session'
    })
  )
  await waitFor(() => expect(result.current.sessions).toEqual([child]))
  expect(call).toHaveBeenCalledWith(
    target,
    'agentSession.subagents',
    { sessionId: 'machine-session' },
    { timeoutMs: 15_000 }
  )
})

it('keeps terminal-backed transcript lookup unchanged', async () => {
  call.mockResolvedValue({ sessions: [child] })
  const { result } = renderHook(() =>
    useAgentSubagentSessions({ target, agent: 'codex', parentFilePath: '/remote/parent.jsonl' })
  )
  await waitFor(() => expect(result.current.sessions).toEqual([child]))
  expect(call).toHaveBeenCalledWith(
    target,
    'aiVault.listSubagentSessions',
    { agent: 'codex', parentFilePath: '/remote/parent.jsonl' },
    { timeoutMs: 15_000 }
  )
})

it('degrades safely on an older host without the machine list method', async () => {
  call.mockRejectedValue(new Error('method_not_found'))
  const { result } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'codex',
      parentFilePath: null,
      structuredSessionId: 'machine-session'
    })
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.sessions).toEqual([])
  expect(call).toHaveBeenCalledOnce()
})

it('polls a running child after the parent is idle and stops on completion/unmount', async () => {
  vi.useFakeTimers()
  call.mockResolvedValue({ sessions: [{ ...child, subagent: { status: 'running' } }] })
  const { result, unmount } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'codex',
      parentFilePath: null,
      structuredSessionId: 'machine-session'
    })
  )
  await act(async () => {})
  call.mockResolvedValue({ sessions: [child] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(result.current.sessions).toEqual([child])
  const count = call.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000)
  })
  expect(call).toHaveBeenCalledTimes(count)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
