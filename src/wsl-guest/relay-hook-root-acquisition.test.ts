import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { createRelayPaneRootResolver } from './relay-pane-root'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import { readHookRootEvidence } from '../shared/hook-process-root-evidence'
import type { ProcessTableRow } from '../shared/process-table-snapshot'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

const BOOT = '0b1d2c3e-4f50-4617-8293-a4b5c6d7e8f9'
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const row = (pid: number, ppid: number, pgid: number, command: string, tty = 'pts/3') => ({
  pid,
  ppid,
  pgid,
  tpgid: tty === 'pts/3' ? 4001 : -1,
  tty,
  stat: tty === 'pts/3' ? 'S+' : 'S',
  command
})
// A WSL pane: the bootstrap's exec'd login shell is the guest root; Claude's Bash tool runs the
// nested run in its own session with no terminal.
const rows: ProcessTableRow[] = [
  row(100, 1, 100, '/bin/bash --rcfile /mnt/c/orca/shell-ready/bash/rcfile'),
  row(4001, 100, 4001, 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
  row(4005, 4001, 4005, '/bin/bash -c claude -p summarize', '?'),
  row(4006, 4005, 4005, 'claude -p summarize', '?')
]

async function relay(request: (paneKey: string) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-root-acquisition-'))
  const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
  const io = {
    resolveRoot: createRelayPaneRootResolver(request),
    probe,
    readProcesses: vi.fn(async (pids: readonly number[]) =>
      rows.filter((entry) => pids.includes(entry.pid))
    ),
    readTerminal: vi.fn(async (tty: string) => rows.filter((entry) => entry.tty === tty))
  }
  const server = new RelayAgentHookServer({
    endpointDir: dir,
    forward,
    readHookRootEvidence: (hook) => readHookRootEvidence(hook, io)
  })
  await server.start()
  const { port, token } = server.getCoordinates()
  const post = async (pid: number | null, payload: Record<string, unknown>, pane = paneKey) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: pane,
        tabId: pane.split(':')[0],
        worktreeId: 'wt-1',
        ...(pid === null
          ? {}
          : { agentProcess: { pid, platform: 'linux', startTime: `${BOOT}:${pid}00` } }),
        payload
      })
    })
    expect(response.status).toBe(204)
  }
  const stop = async () => {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  }
  return { post, forward, io, stop }
}

it('acquires from the guest root its desktop names, and keeps a nested run out', async () => {
  const request = vi.fn(async () => ({
    root: { pid: 100, startTime: `${BOOT}:10000` },
    incarnation: 'inc-1'
  }))
  const { post, forward, stop } = await relay(request)
  try {
    await post(null, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'parent',
      prompt: 'Parent task'
    })
    forward.mockClear()
    await post(4006, { hook_event_name: 'UserPromptSubmit', session_id: 'child', prompt: 'Child' })
    await post(4006, {
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
    expect(request).toHaveBeenCalledWith(paneKey)
    // The desktop's named root is confirmed in this guest before it anchors anything.
    expect(probe).toHaveBeenCalledWith({ pid: 100, platform: 'linux', startTime: `${BOOT}:10000` })
  } finally {
    await stop()
  }
})

it('keeps the legacy path, asking once, when the desktop predates pane roots', async () => {
  const request = vi.fn(async () => {
    throw Object.assign(new Error('Method not found'), { code: -32601 })
  })
  const { post, forward, io, stop } = await relay(request)
  try {
    const other = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
    for (const pane of [paneKey, other]) {
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
        await post(4001, { hook_event_name: event, session_id: 'parent', prompt: 'Task' }, pane)
      }
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        paneKey: pane,
        agentPresence: { agent: 'claude', process: { pid: 4001 } }
      })
    }
    expect(request).toHaveBeenCalledOnce()
    expect(io.readTerminal).not.toHaveBeenCalled()
  } finally {
    await stop()
  }
})
