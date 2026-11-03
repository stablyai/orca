import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'
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
  return { post, forward, io, server, stop }
}

const LINK = 'wsl:Ubuntu'
const readA = { tool_name: 'Read', tool_input: { file_path: '/a' } }

/** A relay whose desktop names the pane's root only once released, as on a loaded host, feeding
 *  that desktop, which issues the binding the relay echoes. */
async function slowRootPair() {
  const desktop = new AgentHookServer()
  let release = (): void => {}
  const named = new Promise<unknown>((resolve) => {
    release = () =>
      resolve({
        root: { pid: 100, startTime: `${BOOT}:10000` },
        incarnation: desktop.relayPaneRootIssuer(LINK)(paneKey, 'inc-1', () => true)
      })
  })
  const pair = await relay(() => named)
  pair.forward.mockImplementation((envelope) => desktop.ingestRemote(envelope, LINK))
  const stored = () => desktop._getStateForTests().lastStatusByPaneKey.get(paneKey)
  const proved = () =>
    vi.waitFor(() =>
      expect(pair.forward.mock.lastCall?.[0]).toMatchObject({
        agentPresence: { process: { pid: 4001 }, paneRoot: expect.any(String) }
      })
    )
  const stop = async () => {
    desktop.stop()
    await pair.stop()
  }
  return { ...pair, desktop, stored, proved, release, stop }
}

async function waitingOnA(post: Awaited<ReturnType<typeof relay>>['post']): Promise<void> {
  await post(4001, { hook_event_name: 'UserPromptSubmit', session_id: 'parent', prompt: 'Read' })
  await post(4001, {
    hook_event_name: 'PreToolUse',
    session_id: 'parent',
    tool_use_id: 'A',
    ...readA
  })
  await post(4001, { hook_event_name: 'PermissionRequest', session_id: 'parent', ...readA })
}

it('records a late root under a held request, keeping the request on the relay and the desktop', async () => {
  const { post, forward, desktop, stored, proved, release, stop } = await slowRootPair()
  try {
    await waitingOnA(post)
    expect(stored()).toMatchObject({
      hookEventName: 'PermissionRequest',
      payload: { state: 'waiting' }
    })
    release()
    await proved()
    expect(forward.mock.lastCall?.[0].claudePermission).toMatchObject({
      held: true,
      row: { hookEventName: 'PermissionRequest', payload: { state: 'waiting', toolName: 'Read' } }
    })
    // The desktop keeps A's card and takes the proved owner, so its exit can still be seen.
    expect(stored()).toMatchObject({
      hookEventName: 'PermissionRequest',
      payload: { state: 'waiting', toolName: 'Read' },
      agentPresence: { process: { pid: 4001 } }
    })
    expect(stored()?.agentPresence?.fallback).toBeUndefined()
    expect(desktop.hasVerifiableAgentProcess(paneKey)).toBe(true)
  } finally {
    await stop()
  }
})

it('caches and forwards a released request’s late root as the current row, never as its batch again', async () => {
  const { post, forward, server, desktop, stored, proved, release, stop } = await slowRootPair()
  try {
    await waitingOnA(post)
    await post(4001, {
      hook_event_name: 'PostToolBatch',
      session_id: 'parent',
      tool_calls: [{ ...readA, tool_use_id: 'A' }]
    })
    expect(stored()?.payload.state).toBe('working')
    release()
    await proved()
    expect(forward.mock.lastCall?.[0]).toMatchObject({ payload: { state: 'working' } })
    expect(stored()).toMatchObject({
      payload: { state: 'working' },
      agentPresence: { process: { pid: 4001 } }
    })
    expect(desktop.hasVerifiableAgentProcess(paneKey)).toBe(true)
    // The relay cached that row: a reconnect replays the proved owner with A still released.
    server.replayCachedPayloadsForPanes()
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      isReplay: true,
      agentPresence: { process: { pid: 4001 }, paneRoot: expect.any(String) },
      payload: { state: 'working' }
    })
    expect(stored()?.payload.state).toBe('working')
  } finally {
    await stop()
  }
})

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
