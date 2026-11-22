import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayAgentHookServer } from '../server/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { probeAgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence-probe'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const line = (record: unknown) => `${JSON.stringify(record)}\n`

describe('RelayAgentHookServer Droid turn outcome', () => {
  const dirs: string[] = []
  const servers: RelayAgentHookServer[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['model_authentication_failed', { outcome: 'failure' }],
    ['cancelled', { outcome: 'cancellation' }]
  ])('forwards the %s verdict Droid records just after Stop', async (reason, verdict) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-droid-outcome-'))
    dirs.push(dir)
    const transcriptPath = join(dir, `${SESSION}.jsonl`)
    writeFileSync(
      transcriptPath,
      line({ type: 'session_start', id: SESSION }) +
        line({ type: 'message', id: 'turn-1', message: { role: 'user', content: 'go' } })
    )
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    servers.push(server)
    await server.start()
    const { port, token } = server.getCoordinates()
    const post = async (payload: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/droid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { session_id: SESSION, transcript_path: transcriptPath, ...payload }
        })
      })
      expect(response.status).toBe(204)
    }

    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop' })
    expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({ state: 'done' })
    expect(forward.mock.calls.at(-1)?.[0].payload.mainAgent).toBeUndefined()

    appendFileSync(transcriptPath, line({ type: 'agent_turn_outcome', turnId: 'turn-1', reason }))

    await vi.waitFor(() =>
      expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done', ...verdict }
      })
    )
  })
})
