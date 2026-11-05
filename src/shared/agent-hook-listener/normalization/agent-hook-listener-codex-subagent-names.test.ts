import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from '../listener-state'
import { pollCodexTranscriptStatus } from '../providers/codex-transcript-poll'
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

  it('retries a matching metadata header that did not yet contain a name', () => {
    const { writeMeta, post } = fixture()
    writeMeta({})
    expect(post()?.[0]?.description).toBeUndefined()

    writeMeta({ agent_path: '/root/review/mobile' })
    expect(post('PostToolUse')?.[0]?.description).toBe('mobile')
  })

  it('publishes distinct delayed worker names on parent polls without reviving completed children', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-polled-child-name-'))
    directories.push(directory)
    const state = createHookListenerState()
    const parentPath = join(directory, 'rollout-parent.jsonl')
    const firstId = '019fa65f-3144-7151-9c02-cff7a28f316f'
    const secondId = '019fa65f-3144-7151-9c02-cff7a28f3170'
    const firstPath = join(directory, `rollout-child-${firstId}.jsonl`)
    const secondPath = join(directory, `rollout-child-${secondId}.jsonl`)
    writeFileSync(parentPath, '')
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      transcript_path: parentPath
    })
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SubagentStart',
      agent_id: firstId,
      agent_type: 'worker'
    })
    let current = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SubagentStart',
      agent_id: secondId,
      agent_type: 'worker',
      transcript_path: secondPath
    })
    expect(current?.payload.subagents?.map((child) => child.description)).toEqual([
      undefined,
      undefined
    ])
    function writeMeta(path: string, id: string, name: string): void {
      writeFileSync(
        path,
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id, source: { subagent: { thread_spawn: { agent_path: `/root/${name}` } } } }
        })}\n`
      )
    }
    function poll() {
      if (!current) {
        throw new Error('Expected a Codex status event')
      }
      current = pollCodexTranscriptStatus(state, current, {}, 'production') ?? null
      return current?.payload.subagents
    }

    writeMeta(firstPath, firstId, 'task_a')
    writeMeta(secondPath, firstId, 'wrong_task')
    expect(poll()).toEqual([
      expect.objectContaining({ id: firstId, agentType: 'worker', description: 'task_a' }),
      expect.objectContaining({ id: secondId, agentType: 'worker', description: undefined })
    ])

    writeMeta(secondPath, secondId, 'task_b')
    expect(poll()).toEqual([
      expect.objectContaining({ id: firstId, agentType: 'worker', description: 'task_a' }),
      expect.objectContaining({ id: secondId, agentType: 'worker', description: 'task_b' })
    ])
    function parentActivity(agentPath: string): void {
      appendFileSync(
        parentPath,
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'sub_agent_activity',
            agent_thread_id: firstId,
            agent_path: agentPath,
            kind: 'interacted'
          }
        })}\n`
      )
    }
    parentActivity('/root/task_a')
    expect(poll()?.[0]?.description).toBe('task_a')
    parentActivity('/root/review/mobile')
    expect(poll()?.[0]?.description).toBe('mobile')

    current = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'PostToolUse',
      agent_id: firstId,
      agent_type: 'worker'
    })
    expect(current?.payload.subagents?.[0]?.description).toBe('mobile')

    appendFileSync(firstPath, '{"type":"event_msg","payload":{"type":"task_complete"}}\n')
    expect(poll()).toEqual([
      expect.objectContaining({ id: secondId, description: 'task_b', state: 'working' })
    ])
    expect(poll()).toEqual([
      expect.objectContaining({ id: secondId, description: 'task_b', state: 'working' })
    ])
  })
})
