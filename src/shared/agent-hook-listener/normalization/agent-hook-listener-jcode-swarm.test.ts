import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { checkHookOwnerPresence } from '../presence/agent-hook-owner-presence'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

// Payloads and session metadata captured from Jcode 0.99.0 (#34005): the daemon fires the inline
// swarm worker's hooks with the coordinator pane's ORCA_PANE_KEY; only session_id differs.
const ROOT = 'session_tigress_1792603131095_636843aadc1b740b'
const WORKER = 'session_retriever_1792603161400_81ad62e08be2201b'
const CWD = '/tmp/jcapt-cwd'
const capturedHooks: Record<string, string>[] = [
  {
    cwd: CWD,
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: ROOT,
    source: 'create'
  },
  {
    cwd: CWD,
    event: 'post_tool',
    session_id: ROOT,
    status: 'ok',
    tool_call_id: 'toolu_01MTzF23AooBwhxhQUGNXSEm',
    tool_input: '{"command":"rtk ls","intent":"List the working directory contents as requested"}',
    tool_name: 'bash'
  },
  {
    cwd: CWD,
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: WORKER,
    source: 'create'
  },
  {
    cwd: CWD,
    event: 'post_tool',
    session_id: ROOT,
    status: 'ok',
    tool_call_id: 'debug-1792603161350',
    tool_input:
      '{"action":"spawn","effort":"low","label":"cap-worker","model":"claude-haiku-5-5","prompt":"Reply with exactly the text worker-ok. Do not use any tools.","spawn_mode":"inline"}',
    tool_name: 'swarm'
  },
  { cwd: CWD, event: 'turn_start', model: 'claude-haiku-5-5', session_id: WORKER, source: 'chat' },
  {
    cwd: CWD,
    event: 'turn_end',
    last_assistant_text: 'worker-ok',
    model: 'claude-haiku-5-5',
    session_id: WORKER,
    status: 'ok'
  }
]

describe('Jcode swarm workers sharing the coordinator pane', () => {
  let home: string
  let state: HookListenerState

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jcode-swarm-'))
    mkdirSync(join(home, 'sessions'))
    vi.stubEnv('JCODE_HOME', home)
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it("keeps the coordinator's row while its inline worker starts and finishes a turn", async () => {
    // Jcode saves `id` then `parent_id` first; the worker is saved before it runs.
    for (const [id, parentId] of [
      [ROOT, null],
      [WORKER, ROOT]
    ]) {
      writeFileSync(
        join(home, 'sessions', `${id}.json`),
        JSON.stringify({ id, parent_id: parentId, title: 'captured', messages: [] })
      )
    }

    const results: unknown[] = []
    for (const payload of capturedHooks) {
      await checkHookOwnerPresence(
        state,
        'jcode',
        { paneKey: PANE_KEY, payload },
        'production',
        () => Promise.resolve()
      )
      results.push(normalizeAndAccept(state, 'jcode', payload))
    }

    expect(results.slice(4)).toEqual([null, null])
    const row = state.lastStatusByPaneKey.get(PANE_KEY)
    expect(row?.payload.state).toBe('working')
    expect(row?.providerSession?.id).toBe(ROOT)
  })
})
