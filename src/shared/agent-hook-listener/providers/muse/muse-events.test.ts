import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../../listener-state'
import { normalizeAndAccept } from '../../normalization/agent-hook-listener-test-harness'

const SESSION_ID = '01a0caa3-0e77-7d41-bad7-46283a45633d'
const TURN_ID = 'e495d1a5-59aa-47b4-8efb-a1bd75509afc'
const CHILD_ID = '1471f5e6-bd60-41a2-bfcf-c9086dbd4092'

const envelope = {
  cwd: '/tmp/ws',
  transcript_path: null,
  model: 'muse-spark-1.3',
  permission_mode: 'default',
  model_provider: 'meta'
}
const main = { ...envelope, session_id: SESSION_ID, turn_id: TURN_ID }

describe('Muse hook events', () => {
  let state: HookListenerState
  let dataHome: string

  beforeEach(() => {
    state = createHookListenerState()
    dataHome = mkdtempSync(join(tmpdir(), 'muse-events-'))
    vi.stubEnv('XDG_DATA_HOME', dataHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dataHome, { recursive: true, force: true })
  })

  // Restart/reconnect can lose the child's SubagentStart.

  // Muse 1.4.14 subagent_spawn trace: the child starts before the lead's Stop and ends long after it.
  const SPAWNED_ID = '01a1afae-e716-7a93-8ecf-67cb69c7e7aa'
  const spawned = { ...envelope, session_id: CHILD_ID, turn_id: CHILD_ID }
  const leadStop = {
    ...main,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'SPAWNED'
  }

  function holdLeadStopForSpawnedChild(): void {
    normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go'
    })
    normalizeAndAccept(state, 'muse', {
      ...spawned,
      hook_event_name: 'SubagentStart',
      subagent_id: SPAWNED_ID,
      child_session_id: CHILD_ID
    })
    expect(normalizeAndAccept(state, 'muse', leadStop)?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' }
    })
  }

  it('holds the finished turn working until the spawned subagent stops', () => {
    holdLeadStopForSpawnedChild()
    expect(
      normalizeAndAccept(state, 'muse', {
        ...spawned,
        hook_event_name: 'SubagentStop',
        subagent_id: SPAWNED_ID,
        child_session_id: CHILD_ID
      })
    ).toBeNull()
    // The transcript poll replays the held Stop.
    expect(normalizeAndAccept(state, 'muse', leadStop)?.payload.state).toBe('done')
  })

  it('releases a held turn when the user interrupts Muse', () => {
    holdLeadStopForSpawnedChild()
    expect(normalizeAndAccept(state, 'muse', { ...main, hook_event_name: 'Interrupt' })).toBeNull()
    expect(normalizeAndAccept(state, 'muse', leadStop)?.payload.state).toBe('done')
  })
})
