import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { makePaneKey } from '../shared/stable-pane-id'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

it.each([false, true])(
  'discards a relay hook after stop during its probe (restart with fixed token: %s)',
  async (restart) => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-http-owner-lifecycle-'))
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({
      endpointDir: directory,
      token: 'fixed-host-issued-token',
      forward
    })
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    const post = (source: string, hook_event_name: string, session: string) => {
      const { port, token } = server.getCoordinates()
      return fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          ...(source === 'claude'
            ? { agentProcess: { pid: 4001, platform: 'linux', startTime: 'birth' } }
            : {}),
          payload: { hook_event_name, session_id: session, prompt: session }
        })
      })
    }
    try {
      await server.start()
      for (const event of ['UserPromptSubmit', 'Stop']) {
        expect((await post('claude', event, 'claude-parent')).status).toBe(204)
      }
      let release: (() => void) | undefined
      probe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve('live')
          })
      )
      const pending = post('codex', 'UserPromptSubmit', 'obsolete-codex')
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
      server.stop()
      if (restart) {
        await server.start()
      }
      forward.mockClear()
      release?.()
      expect((await pending).status).toBe(204)
      expect(forward).not.toHaveBeenCalled()
      expect(server.replayCachedPayloadsForPanes()).toBe(0)
      if (restart) {
        expect((await post('codex', 'UserPromptSubmit', 'current-codex')).status).toBe(204)
        expect(forward.mock.lastCall?.[0]).toMatchObject({
          providerSession: { id: 'current-codex' },
          payload: { agentType: 'codex' }
        })
        forward.mockClear()
        expect(server.replayCachedPayloadsForPanes()).toBe(1)
        expect(forward.mock.lastCall?.[0].providerSession?.id).toBe('current-codex')
      }
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
