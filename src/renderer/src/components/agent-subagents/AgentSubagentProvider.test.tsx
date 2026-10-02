// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSubagentProvider } from './AgentSubagentProvider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAgentSubagentContext, type AgentSubagentSource } from './AgentSubagentContext'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))
afterEach(() => {
  cleanup()
  call.mockReset()
})

function Open() {
  const context = useAgentSubagentContext()
  return <button onClick={() => context?.open('parent')}>Open subagents</button>
}

it('refreshes idle/unknown children when opened without downgrading a pinned root lookup', async () => {
  const child = {
    id: 'child',
    sessionId: 'child',
    title: 'Worker',
    agent: 'omp',
    filePath: '/custom/child.jsonl',
    messageCount: 2,
    subagent: { status: null }
  }
  call
    .mockResolvedValueOnce({ sessions: [child] })
    .mockResolvedValue({ sessions: [{ ...child, subagent: { status: 'completed' } }] })
  const source: AgentSubagentSource = {
    key: 'parent',
    identity: 'omp',
    agent: 'omp',
    sessionId: 'parent',
    structuredSessionId: 'parent',
    transcriptPath: '/custom/parent.jsonl',
    target: { kind: 'local' },
    liveSubagents: [],
    working: false
  }
  render(
    <TooltipProvider>
      <AgentSubagentProvider sources={[source]}>
        <Open />
      </AgentSubagentProvider>
    </TooltipProvider>
  )
  await waitFor(() => expect(call).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Open subagents' }))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: /Worker/ })).toBeTruthy()
  await waitFor(() => expect(screen.queryByText('Status unavailable')).toBeNull())
  for (const args of call.mock.calls) {
    expect(args).toEqual([
      { kind: 'local' },
      'agentSession.subagents',
      { sessionId: 'parent' },
      { timeoutMs: 15_000 }
    ])
  }
})
