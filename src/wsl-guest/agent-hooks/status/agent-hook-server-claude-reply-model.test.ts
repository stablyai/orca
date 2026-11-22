import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../server/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-claude-reply-model-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Remote hosts relay hooks but no statusline, so the Stop reply is their only sign of /model.
it('forwards the model a remote Claude reply names after /model', async () => {
  const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
  const relay = new RelayAgentHookServer({ endpointDir: dir, forward })
  await relay.start()
  const transcriptPath = join(dir, 'session.jsonl')
  const post = async (payload: Record<string, unknown>) => {
    const { port, token } = relay.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { session_id: 'claude-1', transcript_path: transcriptPath, ...payload }
      })
    })
    expect(response.status).toBe(204)
  }
  try {
    await post({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'second' })
    writeFileSync(
      transcriptPath,
      [
        { type: 'user', message: { role: 'user', content: 'second' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-fable-5-2',
            content: [{ type: 'text', text: 'Two.' }]
          }
        }
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('')
    )
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Two.' })
    expect(forward.mock.calls.at(-1)?.[0]).toMatchObject({
      payload: { state: 'done', model: 'claude-fable-5-2' }
    })
  } finally {
    relay.stop()
  }
})
