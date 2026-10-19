// The relay owns a remote pane's Claude records, so it — not the desktop — must restate a pane
// that was held working by a task notification Claude never sent.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from '../shared/claude-owed-task-notifications'
import { makePaneKey } from '../shared/stable-pane-id'
import { RelayAgentHookServer } from './agent-hook-server'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SHELL = { id: 'b1', type: 'shell', status: 'running' }

describe('Claude owed task notification expiry on the relay', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-expiry-'))
    // Why shouldAdvanceTime: the hooks are real loopback POSTs, which need the clock to move.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['Stop', 'Escape'])(
    'forwards the settled row after %s when a launched shell vanished without a notification',
    async (ending) => {
      const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
      const server = new RelayAgentHookServer({ endpointDir: dir, forward })
      await server.start()
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: { session_id: 'session-1', ...payload }
          })
        })
      try {
        await post({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
        await post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { backgroundTaskId: SHELL.id }
        })
        await post({ hook_event_name: 'Stop', background_tasks: [SHELL] })
        if (ending === 'Escape') {
          await post({ hook_event_name: 'Stop', background_tasks: [] })
        }
        await post({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })
        if (ending === 'Stop') {
          await post({ hook_event_name: 'Stop', background_tasks: [] })
        } else {
          server.claudeTerminalInterrupts.observe(PANE_KEY, { kind: 'title', title: '◐ Thanks' })
          server.claudeTerminalInterrupts.observe(PANE_KEY, { kind: 'input', data: '\x1b[27u' })
          server.claudeTerminalInterrupts.observe(PANE_KEY, { kind: 'title', title: '✳ Thanks' })
          expect(forward.mock.lastCall?.[0].payload).toMatchObject({
            mainAgent: { state: 'done', outcome: 'cancellation' },
            claudeTaskWakeupPending: 'notification'
          })
        }
        expect(forward.mock.lastCall?.[0].payload.state).toBe('working')

        vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)

        expect(forward.mock.lastCall?.[0]).toMatchObject({
          paneKey: PANE_KEY,
          claudeRunningNonAgentTask: false,
          payload: { state: 'done' }
        })
      } finally {
        server.stop()
      }
    }
  )
})
