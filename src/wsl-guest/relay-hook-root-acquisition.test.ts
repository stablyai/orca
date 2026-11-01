import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import { createHookRootEvidenceReader } from '../shared/hook-process-root-evidence'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

const row = (pid: number, ppid: number, pgid: number, command: string, stat = 'S+') => ({
  pid,
  ppid,
  pgid,
  tpgid: 4001,
  tty: 'pts/3',
  stat,
  command
})

it('derives root evidence in the guest: a nested run is refused and the root acquires the pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-root-acquisition-'))
  const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
  const readTable = vi.fn(async () => [
    row(100, 90, 100, '-bash', 'Ss'),
    row(4001, 100, 4001, 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    row(4002, 4001, 4001, 'claude -p summarize')
  ])
  const server = new RelayAgentHookServer({
    endpointDir: dir,
    forward,
    readHookRootEvidence: createHookRootEvidenceReader({ probe, readTable })
  })
  const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  try {
    await server.start()
    const { port, token } = server.getCoordinates()
    const post = async (pid: number | null, payload: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          ...(pid === null
            ? {}
            : { agentProcess: { pid, platform: 'linux', startTime: `0b1d:${pid}00` } }),
          payload
        })
      })
      expect(response.status).toBe(204)
    }
    await post(null, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'parent',
      prompt: 'Parent task'
    })
    forward.mockClear()
    await post(4002, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'child',
      prompt: 'Child task'
    })
    await post(4002, {
      hook_event_name: 'SessionEnd',
      session_id: 'child',
      reason: 'prompt_input_exit'
    })
    expect(forward).not.toHaveBeenCalled()
    await post(4001, { hook_event_name: 'PostToolUse', session_id: 'parent', tool_name: 'Bash' })
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      providerSession: { id: 'parent' },
      agentPresence: { agent: 'claude', process: { pid: 4001 }, session: 'parent' },
      payload: { prompt: 'Parent task' }
    })
  } finally {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
