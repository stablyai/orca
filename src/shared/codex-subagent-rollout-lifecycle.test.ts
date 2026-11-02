import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

describe('Codex rollout subagent lifecycle', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('surfaces a collaboration child without lifecycle hooks and retires it on task_complete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-lifecycle-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      parentPath,
      jsonl([
        {
          type: 'event_msg',
          payload: {
            type: 'sub_agent_activity',
            occurred_at_ms: 1234,
            agent_thread_id: CHILD_ID,
            agent_path: '/root/pr_review',
            kind: 'started'
          }
        }
      ])
    )
    writeFileSync(childPath, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    const state = createHookListenerState()
    const event = (hookEventName: string): ReturnType<typeof normalizeHookPayload> =>
      normalizeHookPayload(
        state,
        'codex',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: hookEventName,
            session_id: 'root-session',
            transcript_path: parentPath,
            tool_name: 'collaborationspawn_agent'
          }
        },
        'production'
      )

    const spawned = event('PostToolUse')
    expect(spawned?.payload).toMatchObject({
      state: 'working',
      subagents: [
        {
          id: CHILD_ID,
          description: '/root/pr_review',
          state: 'working',
          startedAt: 1234
        }
      ]
    })

    const leadStopped = event('Stop')
    expect(leadStopped?.payload.state).toBe('working')
    expect(leadStopped?.payload.subagents).toHaveLength(1)

    writeFileSync(
      childPath,
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
    )
    const completed = event('Stop')
    expect(completed?.payload.state).toBe('done')
    expect(completed?.payload.subagents).toBeUndefined()
  })
})
