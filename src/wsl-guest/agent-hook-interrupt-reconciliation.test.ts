import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { RemoteAgentInterruptRequest } from '../shared/agent-hook-interrupt-reconciliation'
import { makePaneKey } from '../shared/stable-pane-id'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'
import { RelayAgentHookServer } from './agent-hook-server'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cancel-fence-'))
  let retired = false
  let ownerLaunch = 'launch-a'
  const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  const server = new RelayAgentHookServer({
    endpointDir: dir,
    forward,
    getAgentLaunchToken: () => ownerLaunch,
    isPaneSurfaceRetired: () => retired
  })
  await server.start({ publishEndpoint: false })
  const post = async (payload: Record<string, unknown>) => {
    const { port, token } = server.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        launchToken: 'launch-a',
        payload: { session_id: 'session-a', ...payload }
      })
    })
    expect(response.status).toBe(204)
  }
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'start work' })
  const row = forward.mock.lastCall?.[0]
  if (!row?.hostTurnRevision || !row.providerSession) {
    throw new Error('Missing host proof')
  }
  const command: RemoteAgentInterruptRequest = {
    paneKey: PANE,
    hostTurnRevision: row.hostTurnRevision,
    launchToken: row.launchToken,
    providerSession: row.providerSession,
    intent: 'ctrl-c'
  }
  return {
    server,
    post,
    command,
    forward,
    retire: () => {
      retired = true
    },
    replaceLaunch: () => {
      ownerLaunch = 'launch-b'
    },
    close: () => {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('relay interrupt owner reconciliation', () => {
  it.each(['current', 'replacement before busy', 'replacement after Escape', 'stale', 'retired'])(
    'fences native Escape evidence against a %s PTY owner',
    async (scenario) => {
      const host = await fixture()
      const clock = vi.spyOn(Date, 'now')
      try {
        if (scenario === 'replacement before busy') {
          host.replaceLaunch()
        }
        if (scenario === 'stale') {
          clock.mockReturnValue(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
        }
        host.forward.mockClear()
        const native = host.server.claudeTerminalInterrupts
        native.observe(PANE, { kind: 'title', title: '◐ Task' })
        native.observe(PANE, { kind: 'input', data: '\x1b[27u' })
        if (scenario === 'replacement after Escape') {
          host.replaceLaunch()
        }
        if (scenario === 'retired') {
          host.retire()
        }
        native.observe(PANE, { kind: 'title', title: '✳ Task' })
        expect(host.forward).toHaveBeenCalledTimes(scenario === 'current' ? 1 : 0)
        if (scenario === 'current') {
          expect(host.forward.mock.lastCall?.[0].payload.mainAgent?.outcome).toBe('cancellation')
        }
      } finally {
        clock.mockRestore()
        host.close()
      }
    }
  )

  it.each(['revision', 'launch', 'session', 'intent', 'pane'])(
    'refuses a wrong %s proof',
    async (field) => {
      const host = await fixture()
      try {
        const invalid = {
          ...host.command,
          ...(field === 'revision'
            ? { hostTurnRevision: '00000000-0000-0000-0000-000000000000' }
            : {}),
          ...(field === 'launch' ? { launchToken: 'launch-b' } : {}),
          ...(field === 'session'
            ? { providerSession: { key: 'session_id', id: 'session-b' } }
            : {}),
          ...(field === 'intent' ? { intent: 'plain-escape' } : {}),
          ...(field === 'pane' ? { paneKey: 'other-pane' } : {})
        }
        expect(host.server.inferInterrupt(invalid)).toBe(false)
        expect(host.forward.mock.lastCall?.[0].payload.mainAgent?.state).toBe('working')
      } finally {
        host.close()
      }
    }
  )

  it.each([
    'retired',
    'launch-replaced',
    'new-prompt',
    'same-prompt',
    'changed-own-prompt',
    'new-session',
    'task-wakeup',
    'stopped-host'
  ])('refuses a command after %s supersedes the row', async (change) => {
    const host = await fixture()
    try {
      if (change === 'retired') {
        host.retire()
      }
      if (change === 'launch-replaced') {
        host.replaceLaunch()
      }
      if (change === 'new-prompt') {
        await host.post({ hook_event_name: 'UserPromptSubmit', prompt: 'new work' })
      }
      if (change === 'same-prompt') {
        await host.post({ hook_event_name: 'UserPromptSubmit', prompt: 'start work' })
      }
      if (change === 'changed-own-prompt') {
        await host.post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          prompt: 'another request'
        })
      }
      if (change === 'new-session') {
        await host.post({
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'session-b'
        })
      }
      if (change === 'task-wakeup') {
        await host.post({
          hook_event_name: 'UserPromptSubmit',
          prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
        })
      }
      if (change === 'stopped-host') {
        host.server.stop()
      }
      expect(host.server.inferInterrupt(host.command)).toBe(false)
    } finally {
      host.close()
    }
  })

  it('acknowledges the current owner once and keeps a later genuine prompt working', async () => {
    const host = await fixture()
    try {
      await host.post({ hook_event_name: 'PostToolUse', tool_name: 'Read' })
      expect(host.server.inferInterrupt(host.command)).toBe(true)
      expect(host.forward.mock.lastCall?.[0].payload).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(host.server.inferInterrupt(host.command)).toBe(false)
      await host.post({ hook_event_name: 'PostToolUse', tool_name: 'Read' })
      expect(host.forward.mock.lastCall?.[0].payload.mainAgent?.outcome).toBe('cancellation')
      await host.post({ hook_event_name: 'UserPromptSubmit', prompt: 'new work' })
      expect(host.forward.mock.lastCall?.[0].payload.mainAgent?.state).toBe('working')
    } finally {
      host.close()
    }
  })
})
