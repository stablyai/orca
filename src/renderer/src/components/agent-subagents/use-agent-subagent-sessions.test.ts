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

it.each(['claude', 'openclaude', 'codex', 'grok', 'omp'])(
  'loads %s machine children on their owning host without a parent transcript path',
  async (agent) => {
    call.mockResolvedValue({ sessions: [child] })
    const { result } = renderHook(() =>
      useAgentSubagentSessions({
        target,
        agent,
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
  }
)

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

it.each(['grok', 'omp'])(
  'resolves %s terminal children on their host when hooks omit the path',
  async (agent) => {
    call.mockResolvedValue({ sessions: [child] })
    const { result } = renderHook(() =>
      useAgentSubagentSessions({ target, agent, parentFilePath: null, parentSessionId: 'parent' })
    )
    await waitFor(() => expect(result.current.sessions).toEqual([child]))
    expect(call).toHaveBeenCalledWith(
      target,
      'aiVault.listSubagentSessions',
      { agent, parentSessionId: 'parent' },
      { timeoutMs: 15_000 }
    )
  }
)

it('does not send unsupported agents through another provider', () => {
  renderHook(() =>
    useAgentSubagentSessions({ target, agent: 'opencode', parentFilePath: '/remote/parent.jsonl' })
  )
  expect(call).not.toHaveBeenCalled()
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

it('falls back to file lookup when an older host ignores the nested parent selector', async () => {
  call
    .mockResolvedValueOnce({ sessions: [{ ...child, sessionId: 'wrong-root-child' }] })
    .mockResolvedValue({ sessions: [child] })
  const { result } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'omp',
      parentFilePath: '/host/child.jsonl',
      structuredSessionId: 'owner'
    })
  )
  await waitFor(() => expect(result.current.sessions).toEqual([child]))
  expect(call).toHaveBeenNthCalledWith(
    2,
    target,
    'aiVault.listSubagentSessions',
    { agent: 'omp', parentFilePath: '/host/child.jsonl' },
    { timeoutMs: 15_000 }
  )
})

it('uses the acknowledged owning-host nested result without a second request', async () => {
  call.mockResolvedValue({ sessions: [child], parentFilePath: '/host/child.jsonl' })
  const { result } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'omp',
      parentFilePath: '/host/child.jsonl',
      structuredSessionId: 'owner'
    })
  )
  await waitFor(() => expect(result.current.sessions).toEqual([child]))
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

it('never carries sibling rows across a failed nested source switch', async () => {
  call.mockResolvedValueOnce({ sessions: [child] }).mockRejectedValue(new Error('offline'))
  const { result, rerender } = renderHook(
    ({ parentFilePath }) => useAgentSubagentSessions({ target, agent: 'grok', parentFilePath }),
    { initialProps: { parentFilePath: '/host/a.jsonl' } }
  )
  await waitFor(() => expect(result.current.sessions).toEqual([child]))
  rerender({ parentFilePath: '/host/b.jsonl' })
  expect(result.current.sessions).toEqual([])
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.sessions).toEqual([])
})

it('does not overlap slow remote polls or publish after unmount', async () => {
  vi.useFakeTimers()
  let complete!: (value: unknown) => void
  call.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const { unmount } = renderHook(() =>
    useAgentSubagentSessions({
      target,
      agent: 'omp',
      parentFilePath: '/host/parent.jsonl',
      poll: true
    })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(call).toHaveBeenCalledOnce()
  unmount()
  await act(async () => complete({ sessions: [child] }))
  expect(vi.getTimerCount()).toBe(0)
})
