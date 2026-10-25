import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope, AgentHookSource } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('relay provider normalization', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-provider-normalization-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('forwards mixed-provider spool replay without losing the new prompt', async () => {
    const spoolDir = join(dir, 'spool')
    mkdirSync(spoolDir)
    writeFileSync(
      join(spoolDir, 'pane.jsonl'),
      `${[
        ['codex', { hook_event_name: 'UserPromptSubmit', prompt: 'Old turn' }],
        ['claude', { hook_event_name: 'UserPromptSubmit', prompt: 'New turn' }],
        ['claude', { hook_event_name: 'PreToolUse', tool_name: 'Read' }]
      ]
        .map(([source, payload]) =>
          JSON.stringify({
            paneKey: PANE,
            tabId: 'tab-1',
            source,
            payload,
            receivedAt: Date.now()
          })
        )
        .join('\n')}\n`
    )
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const relay = new RelayAgentHookServer({ endpointDir: dir, forward })
    try {
      await relay.start()
      expect(forward).toHaveBeenCalledTimes(3)
      expect(forward.mock.calls[2][0]).toMatchObject({
        isReplay: true,
        payload: { agentType: 'claude', prompt: 'New turn', toolName: 'Read' }
      })
    } finally {
      relay.stop()
    }
  })

  it('forwards a new provider despite the cached owner and replays its latest prompt', async () => {
    const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
    const relay = new RelayAgentHookServer({ endpointDir: dir, forward })
    await relay.start()
    const post = async (source: AgentHookSource, payload: Record<string, unknown>) => {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload })
      })
      expect(response.status).toBe(204)
    }
    try {
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Old Codex turn',
        session_id: 'codex-old'
      })
      // A desktop interrupt can finish Codex without changing the relay's cached working row.
      await post('claude', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'New Claude turn',
        session_id: 'claude-new'
      })
      await post('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'claude-new',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' }
      })
      expect(forward).toHaveBeenCalledTimes(3)
      expect(forward.mock.calls[2][0]).toMatchObject({
        providerSession: { id: 'claude-new' },
        payload: { agentType: 'claude', prompt: 'New Claude turn', toolName: 'Read' }
      })
      forward.mockClear()
      expect(relay.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        isReplay: true,
        providerSession: { id: 'claude-new' },
        payload: { agentType: 'claude', prompt: 'New Claude turn' }
      })
      await post('codex', {
        hook_event_name: 'PreToolUse',
        session_id: 'codex-old',
        tool_name: 'shell'
      })
      expect(forward.mock.calls.at(-1)?.[0].payload.prompt).toBe('Old Codex turn')
      await post('claude', {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-new',
        tool_name: 'Read'
      })
      expect(forward.mock.calls.at(-1)?.[0].payload.prompt).toBe('New Claude turn')
      relay.clearPaneState(PANE)
      await post('claude', { hook_event_name: 'PreToolUse', tool_name: 'Read' })
      expect(forward.mock.calls.at(-1)?.[0].payload.prompt).toBe('')
    } finally {
      relay.stop()
    }
  })
})
