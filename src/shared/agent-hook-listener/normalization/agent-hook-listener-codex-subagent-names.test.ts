import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from '../listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'
import { pollCodexTranscriptStatus } from '../providers/codex-transcript-poll'

describe('Codex child names from provider metadata', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'codex-child-name-'))
    directories.push(directory)
    const transcriptPath = join(directory, 'rollout-child.jsonl')
    const state = createHookListenerState()
    return {
      transcriptPath,
      writeMeta(fields: Record<string, unknown>, nested = true, id = 'child') {
        const payload = nested
          ? { id, source: { subagent: { thread_spawn: fields } } }
          : { id, ...fields }
        writeFileSync(transcriptPath, `${JSON.stringify({ type: 'session_meta', payload })}\n`)
      },
      post(hookEventName = 'SubagentStart', agentType = 'default') {
        return normalizeAndAccept(state, 'codex', {
          hook_event_name: hookEventName,
          agent_id: 'child',
          agent_type: agentType,
          transcript_path: transcriptPath
        })
      },
      state
    }
  }

  it('names a hook-only child, retains its name across waits and clears it on stop', () => {
    const { writeMeta, post, transcriptPath } = fixture()
    writeMeta({ agent_path: '/root/adversarial_visual', agent_nickname: 'Scout' })
    appendFileSync(transcriptPath, 'x'.repeat(2 * 1024 * 1024))

    expect(post()?.payload.subagents).toEqual([
      expect.objectContaining({
        id: 'child',
        agentType: 'default',
        description: 'adversarial_visual',
        state: 'working'
      })
    ])
    rmSync(transcriptPath)
    expect(post('PermissionRequest')?.payload.subagents?.[0]).toMatchObject({
      description: 'adversarial_visual',
      state: 'waiting'
    })
    expect(post('PostToolUse')?.payload.subagents?.[0]).toMatchObject({
      description: 'adversarial_visual',
      state: 'working'
    })
    expect(post('SubagentStop')?.payload.subagents).toBeUndefined()
  })

  it('recovers a child first seen in a tool hook and retries metadata that was not yet written', () => {
    const { writeMeta, post } = fixture()
    expect(post('PostToolUse')?.payload.subagents).toEqual([
      expect.objectContaining({
        id: 'child',
        agentType: 'default',
        description: undefined,
        state: 'working'
      })
    ])
    writeMeta({ agent_path: '/root/review/mobile' })
    expect(post('PostToolUse')?.payload.subagents?.[0]?.description).toBe('review/mobile')
  })

  it('names a child from its own rollout by polling when no parent rollout is known', () => {
    const { writeMeta, post, state } = fixture()
    // A relay restart can leave only this child hook, sent before its rollout was readable.
    const started = post('SubagentStart', 'worker')
    expect(started?.payload.subagents?.[0]).toMatchObject({ agentType: 'worker' })
    expect(started?.payload.subagents?.[0]?.description).toBeUndefined()

    writeMeta({ agent_path: null, agent_nickname: 'Planck', agent_role: 'worker' })
    const polled = pollCodexTranscriptStatus(state, started!, {}, 'production')
    expect(polled?.payload.subagents?.[0]).toMatchObject({
      agentType: 'worker',
      description: 'Planck'
    })
  })
})
