// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { NativeChatMcpPanel } from './NativeChatMcpPanel'
import type { AgentSessionMcpResult } from '../../../../../../shared/agent-session/agent-session-mcp'

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('authenticates on the conversation host and waits for its observed result', async () => {
  const rpc = vi.mocked(callStructuredAgentSession)
  rpc.mockResolvedValueOnce({
    status: 'ok',
    servers: [{ name: 'figma', status: 'needs-auth', canAuthenticate: true }]
  })
  const response = Promise.withResolvers<AgentSessionMcpResult>()
  rpc.mockReturnValueOnce(response.promise)
  render(
    <NativeChatMcpPanel
      transport={{ sessionId: 'windows-chat', runtimeEnvironmentId: 'windows' }}
      fallback={null}
    />
  )
  await act(async () => {})
  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'windows' },
    'agentSession.mcp',
    {
      sessionId: 'windows-chat',
      operation: { action: 'status' }
    }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'windows' },
    'agentSession.mcp',
    {
      sessionId: 'windows-chat',
      operation: { action: 'authenticate', server: 'figma' }
    }
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true)
  expect(screen.queryByText('Connected')).toBeNull()
  await act(async () =>
    response.resolve({
      status: 'ok',
      servers: [{ name: 'figma', status: 'connected', canAuthenticate: true }]
    })
  )
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Reconnect' })).toHaveProperty('disabled', false)
})

it('drops a delayed response from a previous session', async () => {
  const response = Promise.withResolvers<AgentSessionMcpResult>()
  vi.mocked(callStructuredAgentSession)
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce({ status: 'ok', servers: [] })
  const { rerender } = render(
    <NativeChatMcpPanel
      transport={{ sessionId: 'old-chat', runtimeEnvironmentId: null }}
      fallback={null}
    />
  )
  rerender(
    <NativeChatMcpPanel
      transport={{ sessionId: 'new-chat', runtimeEnvironmentId: null }}
      fallback={null}
    />
  )
  await act(async () =>
    response.resolve({
      status: 'ok',
      servers: [{ name: 'old-server', status: 'needs-auth', canAuthenticate: true }]
    })
  )
  expect(screen.queryByText('old-server')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
})
