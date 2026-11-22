// @vitest-environment happy-dom
import * as React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionMcpResult,
  AgentSessionMcpServer
} from '../options/protocol/agent-session-mcp'
import { createAgentSessionMcpPanelHook } from './use-agent-session-mcp-panel'

const useAgentSessionMcpPanel = createAgentSessionMcpPanelHook(React)

const server: AgentSessionMcpServer = {
  name: 'probe',
  status: 'connected',
  source: 'project',
  toolCount: 1,
  error: null,
  canSignIn: false,
  canReconnect: true,
  canToggle: true
}

describe('useAgentSessionMcpPanel', () => {
  it('re-reads when the refresh key changes, even while a read is in flight', async () => {
    let finishFirst: (reply: AgentSessionMcpResult) => void = () => {}
    const request = vi
      .fn<() => Promise<AgentSessionMcpResult>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ status: 'ok', servers: [server] })
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useAgentSessionMcpPanel(request, () => {}, refreshKey),
      { initialProps: { refreshKey: 'at-rest' } }
    )
    // The agent starts while the first read, made at rest, is still out.
    rerender({ refreshKey: 'running' })
    await act(async () => finishFirst({ status: 'not-running' }))
    await waitFor(() => expect(result.current.result).toEqual({ status: 'ok' }))
    expect(result.current.servers).toEqual([server])
  })
})
