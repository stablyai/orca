import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))

const LEAD = 'lead-session'
const AGENT_PROCESS = JSON.stringify({ pid: 4242, platform: process.platform, startTime: 'birth' })
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
let dir: string
let forward: ReturnType<typeof vi.fn<(envelope: AgentHookRelayEnvelope) => void>>
const servers: RelayAgentHookServer[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-droid-exit-'))
  forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  // Why shouldAdvanceTime: the hooks are real loopback POSTs, which need the clock to move.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
  })
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

async function startRelay(): Promise<RelayAgentHookServer> {
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  servers.push(server)
  await server.start()
  return server
}

async function droid(
  server: RelayAgentHookServer,
  event: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  const { port, token } = server.getCoordinates()
  const response = await fetch(`http://127.0.0.1:${port}/hook/droid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': token
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agentProcess: AGENT_PROCESS,
      payload: { hook_event_name: event, session_id: LEAD, ...fields }
    })
  })
  expect(response.status).toBe(204)
}

const last = () => forward.mock.lastCall?.[0]

describe('Droid exit watch on the guest relay', () => {
  it('publishes the row as ended once a probe after a live SessionEnd confirms the exit', async () => {
    const server = await startRelay()
    await droid(server, 'SessionStart')
    await droid(server, 'UserPromptSubmit', { prompt: 'fix the build' })
    await droid(server, 'SessionEnd', { reason: 'prompt_input_exit' })
    await vi.advanceTimersByTimeAsync(250)
    expect(last()?.payload.state).toBe('working')
    expect(last()?.agentPresence?.ended).toBeUndefined()

    probe.mockResolvedValue('exited')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(last()).toMatchObject({
      hookEventName: 'AgentProcessExit',
      providerSessionOnly: true,
      providerSession: { id: 'lead-session' },
      agentPresence: { ended: true }
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(
      forward.mock.calls
        .map(([envelope]) => envelope)
        .filter((envelope) => envelope.agentPresence?.ended)
        .map((envelope) => envelope.hookEventName)
    ).toEqual(['AgentProcessExit'])
  })

  it('does not start a watch for a SessionEnd replayed from the spool', async () => {
    const spoolDir = join(dir, 'spool')
    mkdirSync(spoolDir)
    const record = (hookEventName: string, fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        env: 'remote',
        version: '1',
        source: 'droid',
        hookEventName,
        agentProcess: AGENT_PROCESS,
        payload: { hook_event_name: hookEventName, session_id: LEAD, ...fields },
        receivedAt: Date.now()
      })
    writeFileSync(
      join(spoolDir, 'pane-droid.jsonl'),
      [
        record('SessionStart'),
        record('UserPromptSubmit', { prompt: 'fix the build' }),
        record('SessionEnd', { reason: 'other' })
      ]
        .map((line) => `${line}\n`)
        .join('')
    )

    await startRelay()
    probe.mockResolvedValue('exited')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(last()).toMatchObject({
      hookEventName: 'SessionEnd',
      payload: { state: 'working' },
      providerSession: { id: 'lead-session' }
    })
    expect(last()?.agentPresence?.ended).toBeUndefined()
  })
})
