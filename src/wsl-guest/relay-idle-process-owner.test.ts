import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

it.each(['live', 'unverifiable', 'exited'] as const)(
  'reconciles prior relay suspension when the next process verdict is %s',
  async (verdict) => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-resumed-owner-'))
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    try {
      await server.start()
      const { port, token } = server.getCoordinates()
      const post = async (source: string, event: string, session: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            ...(source === 'claude'
              ? { agentProcess: { pid: 4001, platform: 'linux', startTime: 'birth' } }
              : {}),
            payload: { hook_event_name: event, session_id: session, prompt: `${source} task` }
          })
        })
        expect(response.status).toBe(204)
      }
      await post('claude', 'UserPromptSubmit', 'claude-parent')
      await post('claude', 'Stop', 'claude-parent')
      probe.mockImplementation(async (_identity, _read, _platform, observe) => {
        observe?.(true)
        return 'unverifiable'
      })
      await server.checkAgentPresence(paneKey)
      expect(forward.mock.lastCall?.[0].agentPresence?.suspended).toBe(true)
      if (verdict === 'exited') {
        forward.mockClear()
        probe.mockResolvedValue('exited')
        await server.checkAgentPresence(paneKey)
        expect(forward.mock.lastCall?.[0]).toMatchObject({
          hookEventName: 'AgentProcessExit',
          providerSessionOnly: true,
          agentPresence: { ended: true }
        })
        server.replayCachedPayloadsForPanes()
        expect(forward.mock.lastCall?.[0].agentPresence?.ended).toBe(true)
        return
      }
      probe.mockImplementation(async (_identity, _read, _platform, observe) => {
        if (verdict === 'live') {
          observe?.(false)
        }
        return verdict
      })
      await post('codex', 'UserPromptSubmit', 'nested-codex')
      expect(probe).toHaveBeenCalledTimes(2)
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        providerSession: { id: 'claude-parent' },
        payload: { agentType: 'claude' }
      })
      expect(forward.mock.lastCall?.[0].agentPresence?.suspended).toBeUndefined()
    } finally {
      server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.each(['live', 'unverifiable', 'suspended'] as const)(
  'keeps an idle %s foreground session in relay replay, then accepts a proved replacement',
  async (verdict) => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-idle-owner-'))
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    try {
      await server.start()
      const { port, token } = server.getCoordinates()
      const post = async (source: string, event: string, session: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            ...(source === 'claude'
              ? { agentProcess: { pid: 4001, platform: 'linux', startTime: 'birth' } }
              : {}),
            payload: {
              hook_event_name: event,
              session_id: session,
              ...(event === 'UserPromptSubmit' ? { prompt: `${source} task` } : {})
            }
          })
        })
        expect(response.status).toBe(204)
      }
      await post('claude', 'UserPromptSubmit', 'claude-parent')
      await post('claude', 'Stop', 'claude-parent')
      forward.mockClear()
      if (verdict === 'suspended') {
        probe.mockImplementation(async (_identity, _read, _platform, observe) => {
          observe?.(true)
          return 'unverifiable'
        })
        await post('codex', 'UserPromptSubmit', 'foreground-codex')
        expect(forward.mock.calls[0]?.[0].agentPresence).toMatchObject({
          agent: 'claude',
          suspended: true
        })
        expect(forward.mock.calls[0]?.[0].agentPresence?.ended).toBeUndefined()
        expect(forward.mock.lastCall?.[0]).toMatchObject({
          providerSession: { id: 'foreground-codex' },
          payload: { agentType: 'codex' }
        })
        expect(server.replayCachedPayloadsForPanes()).toBe(1)
        expect(forward.mock.lastCall?.[0]).toMatchObject({
          providerSession: { id: 'foreground-codex' }
        })
        return
      }
      probe.mockResolvedValue(verdict)
      for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
        await post('codex', event, 'nested-codex')
      }
      expect(forward).not.toHaveBeenCalled()
      expect(probe).toHaveBeenCalledTimes(3)
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        isReplay: true,
        providerSession: { id: 'claude-parent' },
        payload: { agentType: 'claude', state: 'done', prompt: 'claude task' }
      })
      await post('claude', 'PreToolUse', 'claude-parent')
      expect(forward.mock.lastCall?.[0].payload.prompt).toBe('claude task')
      probe.mockResolvedValue('exited')
      await post('codex', 'UserPromptSubmit', 'replacement-codex')
      expect(forward.mock.calls.at(-2)?.[0]).toMatchObject({
        hookEventName: 'AgentProcessExit',
        providerSessionOnly: true,
        providerSession: { id: 'claude-parent' },
        agentPresence: { ended: true }
      })
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        providerSession: { id: 'replacement-codex' },
        payload: { agentType: 'codex', prompt: 'codex task' }
      })
      server.replayCachedPayloadsForPanes()
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        isReplay: true,
        providerSession: { id: 'replacement-codex' }
      })
    } finally {
      server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.each(['live', 'exited'] as const)(
  'checks a %s owner before admitting ordered cold relay spool replacements',
  async (verdict) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-owner-spool-'))
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: directory, forward })
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    try {
      await mkdir(join(directory, 'spool'))
      const records = [
        ['claude', 'UserPromptSubmit'],
        ['claude', 'Stop'],
        ['codex', 'UserPromptSubmit'],
        ['codex', 'PreToolUse']
      ]
        .map(
          ([source, hookEventName]) =>
            `${JSON.stringify({
              paneKey,
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              source,
              hookEventName,
              receivedAt: Date.now(),
              ...(source === 'claude'
                ? { agentProcess: { pid: 4001, platform: 'linux', startTime: 'birth' } }
                : {}),
              payload: {
                hook_event_name: hookEventName,
                session_id: `${source}-session`,
                prompt: `${source} task`,
                tool_name: 'shell'
              }
            })}\n`
        )
        .join('')
      await writeFile(join(directory, 'spool', 'pane.jsonl'), records)
      probe.mockResolvedValue(verdict)
      await server.start()
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        providerSession: { id: `${verdict === 'live' ? 'claude' : 'codex'}-session` },
        payload: { agentType: verdict === 'live' ? 'claude' : 'codex' }
      })
      if (verdict === 'exited') {
        expect(forward.mock.lastCall?.[0].hookEventName).toBe('PreToolUse')
      }
    } finally {
      server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
