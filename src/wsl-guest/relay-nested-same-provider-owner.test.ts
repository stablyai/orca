import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

it('keeps a nested claude -p out of the owner row, then admits a Claude after the owner exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-nested-same-provider-'))
  const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  try {
    await server.start()
    const { port, token } = server.getCoordinates()
    const post = async (pid: number, payload: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agentProcess: { pid, platform: 'linux', startTime: `birth-${pid}` },
          payload
        })
      })
      expect(response.status).toBe(204)
    }
    await post(4001, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-parent',
      prompt: 'Parent task'
    })
    forward.mockClear()
    await post(4002, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-child',
      prompt: 'Child task'
    })
    await post(4002, { hook_event_name: 'StopFailure', session_id: 'claude-child' })
    expect(forward).not.toHaveBeenCalled()
    await post(4001, { hook_event_name: 'Stop', session_id: 'claude-parent' })
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      providerSession: { id: 'claude-parent' },
      payload: { state: 'done', prompt: 'Parent task' }
    })
    probe.mockResolvedValue('exited')
    await post(4003, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-next',
      prompt: 'Next task'
    })
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      providerSession: { id: 'claude-next' },
      payload: { state: 'working', prompt: 'Next task' }
    })
  } finally {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
