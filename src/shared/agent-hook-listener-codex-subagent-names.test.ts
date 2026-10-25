import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

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
      post(hookEventName = 'SubagentStart') {
        return normalizeAndAccept(state, 'codex', {
          hook_event_name: hookEventName,
          agent_id: 'child',
          agent_type: 'default',
          transcript_path: transcriptPath
        })?.payload.subagents
      }
    }
  }

  it('names a hook-only child, retains its name across waits and clears it on stop', () => {
    const { writeMeta, post, transcriptPath } = fixture()
    writeMeta({ agent_path: '/root/adversarial_visual', agent_nickname: 'Scout' })
    appendFileSync(transcriptPath, 'x'.repeat(2 * 1024 * 1024))

    expect(post()).toEqual([
      expect.objectContaining({
        id: 'child',
        agentType: 'default',
        description: 'adversarial_visual',
        state: 'working'
      })
    ])
    rmSync(transcriptPath)
    expect(post('PermissionRequest')?.[0]).toMatchObject({
      description: 'adversarial_visual',
      state: 'waiting'
    })
    expect(post('PostToolUse')?.[0]).toMatchObject({
      description: 'adversarial_visual',
      state: 'working'
    })
    expect(post('SubagentStop')).toBeUndefined()
  })

  it('recovers a child first seen in a tool hook and retries metadata that was not yet written', () => {
    const { writeMeta, post } = fixture()
    expect(post('PostToolUse')).toEqual([
      expect.objectContaining({
        id: 'child',
        agentType: 'default',
        description: undefined,
        state: 'working'
      })
    ])
    writeMeta({ agent_path: '/root/review/mobile' })
    expect(post('PostToolUse')?.[0]?.description).toBe('mobile')
  })

  it('uses top-level metadata and falls back to a nickname on older releases', () => {
    const { writeMeta, post } = fixture()
    writeMeta({ agent_path: ' ', agent_nickname: 'Scout' }, false)
    expect(post()?.[0]?.description).toBe('Scout')
  })

  it('keeps the role fallback when metadata belongs to another thread or has no name', () => {
    const { writeMeta, post } = fixture()
    writeMeta({ agent_path: '/root/wrong-child' }, true, 'another-child')
    expect(post()?.[0]).toMatchObject({ agentType: 'default', description: undefined })
    writeMeta({ agent_role: 'default' })
    expect(post('PostToolUse')?.[0]).toMatchObject({
      agentType: 'default',
      description: undefined
    })
  })
})
