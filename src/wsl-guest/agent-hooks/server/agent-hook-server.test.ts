import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import * as agentHookListener from '../../../shared/agent-hook-listener/grok-result-discovery'
import { HOOK_REQUEST_MAX_BYTES } from '../../../shared/agent-hook-listener/request-body'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('RelayAgentHookServer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-server-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards a raw Claude JSON POST with base64 metadata headers', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          'X-Orca-Agent-Hook-Meta': Buffer.from(
            [PANE_KEY, 'tab-1', '', 'wt-1', 'remote', '1'].join('\x1f')
          ).toString('base64')
        },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
      })
      expect(res.status).toBe(204)
      expect(forward).toHaveBeenCalledTimes(1)
      const envelope = forward.mock.calls[0][0]
      expect(envelope.source).toBe('claude')
      expect(envelope.paneKey).toBe(PANE_KEY)
      expect(envelope.tabId).toBe('tab-1')
      expect(envelope.connectionId).toBeNull()
      expect(envelope.payload.state).toBe('working')
      expect(envelope.payload.prompt).toBe('hi')
      expect(envelope.claudeRunningNonAgentTask).toBe(false)
      // Why: the relay forwards body env/version so Orca's warn-once
      // protocol diagnostics and remote-location marker survive the wire.
      expect(envelope.env).toBe('remote')
      expect(envelope.version).toBe('1')
    } finally {
      server.stop()
    }
  })

  it('keeps the relay listening when spool replay forwarding fails', async () => {
    const spoolDir = join(dir, 'spool')
    const spoolFile = join(spoolDir, 'pane-codex.jsonl')
    mkdirSync(spoolDir)
    writeFileSync(
      spoolFile,
      `${JSON.stringify({
        paneKey: PANE_KEY,
        source: 'codex',
        hookEventName: 'SubagentStop',
        payload: { hook_event_name: 'SubagentStop', agent_id: 'child-spooled' },
        receivedAt: Date.now()
      })}\n`
    )
    const server = new RelayAgentHookServer({
      endpointDir: dir,
      forward: () => {
        throw new Error('receiver unavailable')
      }
    })

    try {
      await expect(server.start()).resolves.toBeUndefined()
      expect(server.getCoordinates().port).toBeGreaterThan(0)
      expect(readFileSync(spoolFile, 'utf8')).not.toBe('')
    } finally {
      server.stop()
    }
  })

  it('forwards Claude background monitoring until its authoritative inventory drains', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'Stop',
            background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }]
          }
        })
      })

      expect(forward.mock.calls[0][0]).toMatchObject({
        claudeRunningNonAgentTask: true,
        payload: { state: 'working', workingMode: 'monitoring', agentType: 'claude' }
      })

      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt:
              '<task-notification><task-id>shell-1</task-id><status>completed</status></task-notification>'
          }
        })
      })
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          payload: { hook_event_name: 'Stop', background_tasks: [], session_crons: [] }
        })
      })

      expect(forward).toHaveBeenCalledTimes(3)
      expect(forward.mock.calls[2][0]).toMatchObject({
        claudeRunningNonAgentTask: false,
        payload: { state: 'done', agentType: 'claude' }
      })
    } finally {
      server.stop()
    }
  })

  it('rejects requests with the wrong bearer token (403)', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': 'wrong'
        },
        body: '{}'
      })
      expect(res.status).toBe(403)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('rejects unknown hook paths before parsing the request body', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/unknown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({ value: 'x'.repeat(HOOK_REQUEST_MAX_BYTES + 1) })
      })
      expect(res.status).toBe(404)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  // Reject malformed HTTP events before the wire even though main revalidates at SSH ingress.
  it('does not forward when normalizeHookPayload rejects the event', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: 'tab-1:0',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { hook_event_name: 'BogusEvent', prompt: 'ignored' }
        })
      })
      // Rejected hooks still return 204 so agents never block.
      expect(res.status).toBe(204)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('keeps Copilot transcript retry alive across a following SessionEnd event', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const transcriptPath = join(dir, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'Stop', transcriptPath }
        })
      })
      await fetch(`http://127.0.0.1:${port}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'SessionEnd', reason: 'complete' }
        })
      })
      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      // Let the first 50ms retry miss so continuation across SessionEnd is proven.
      await new Promise((resolve) => setTimeout(resolve, 70))
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant.message',
          data: { content: 'Relay transcript completed.' }
        })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe(
        'Relay transcript completed.'
      )
      // A Stop whose opening the relay never saw is ambiguous; SessionEnd and the retry keep that.
      const ends = forward.mock.calls.map(([env]) => `${env.turnEndedAt}:${env.turnEndDisposition}`)
      expect(new Set(ends)).toEqual(new Set(['undefined:ambiguous']))
    } finally {
      server.stop()
    }
  })

  it('marks a verified re-entered Stop as a later end, an unproven repeat ambiguous, and replays both unchanged', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            env: 'remote',
            version: '1',
            payload
          })
        })
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Lint it' })
      await post({ hook_event_name: 'Stop', last_assistant_message: 'Draft.' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      // Claude re-fires Stop with the flag when a blocking Stop hook continues the same turn.
      await post({
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'Final.'
      })
      const [draft, final] = forward.mock.calls.slice(-2).map(([env]) => env.turnEndedAt)
      expect(final).toBeGreaterThan(draft!)
      await post({ hook_event_name: 'Stop', last_assistant_message: 'Final.' })
      const repeat = { turnEndedAt: final, turnEndDisposition: 'ambiguous' }
      expect(forward.mock.calls.at(-1)?.[0]).toMatchObject(repeat)

      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward.mock.calls.at(-1)?.[0]).toMatchObject({ isReplay: true, ...repeat })
      expect(forward.mock.calls.at(-1)?.[0]).not.toHaveProperty('hostTurn')
    } finally {
      server.stop()
    }
  })

  it('forwards a Grok result when discovery finishes after the old retry window', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf534'
    const cwd = join(dir, 'workspace')
    const sessionDir = join(dir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const history = join(sessionDir, 'chat_history.jsonl')
    writeFileSync(history, '')
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/grok`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            env: 'remote',
            version: '1',
            payload
          })
        })

      await post({ hookEventName: 'UserPromptSubmit', prompt: 'delayed relay result' })
      await post({ hookEventName: 'Stop', sessionId, cwd })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      writeFileSync(
        history,
        `${JSON.stringify({ type: 'assistant', content: 'Relay found after discovery.' })}\n`
      )
      releaseDiscovery()

      await vi.waitFor(() => {
        expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe(
          'Relay found after discovery.'
        )
      })
    } finally {
      server.stop()
      vi.unstubAllEnvs()
    }
  })

  it('does not forward an old result over a newer same-text Grok turn', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/grok`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            env: 'remote',
            version: '1',
            payload
          })
        })

      await post({ hookEventName: 'UserPromptSubmit', prompt: 'repeat me' })
      await post({
        hookEventName: 'Stop',
        sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf535',
        cwd: join(dir, 'workspace')
      })
      await post({ hookEventName: 'UserPromptSubmit', prompt: 'repeat me' })
      const forwardsBeforeDiscovery = forward.mock.calls.length

      releaseDiscovery()
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(forward).toHaveBeenCalledTimes(forwardsBeforeDiscovery)
      expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({
        state: 'working',
        prompt: 'repeat me',
        agentType: 'grok'
      })
    } finally {
      server.stop()
    }
  })
})
