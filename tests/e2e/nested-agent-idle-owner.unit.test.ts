import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import { sleepingRecordFromEntry } from '../../src/renderer/src/store/slices/agent-status/agent-status-sleeping-records'
import { getAgentResumeArgv } from '../../src/shared/agent-session-resume'
import { readAgentProcess } from '../../src/shared/agent-process-presence-probe'
import { AgentHookServer } from '../../src/main/agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../../src/main/agent-hooks/server.test-fixtures'

vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
afterEach(() => vi.useRealTimers())

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'captures Claude resume from real host publications after idle nested Codex hooks with a live OS process',
  async () => {
    const observed = await readAgentProcess(process.pid)
    if (observed.verdict !== 'live') {
      throw new Error('Could not identify the test process')
    }
    const identity = { pid: process.pid, platform: process.platform, startTime: observed.startTime }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = createTestStore()
    const server = new AgentHookServer()
    server.setListener((event) => {
      store
        .getState()
        .setAgentStatus(
          event.paneKey,
          event.payload,
          undefined,
          { updatedAt: event.receivedAt },
          { worktreeId: 'wt-1', tabId: 'tab-1' },
          { providerSession: event.providerSession }
        )
    })
    await server.start({ env: 'production' })
    try {
      for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
        await postHookEvent(
          server,
          buildBody(
            { hook_event_name, session_id: 'claude-parent', prompt: 'Foreground task' },
            { agentProcess: JSON.stringify(identity) }
          )
        )
      }
      expect(store.getState().agentStatusByPaneKey[PANE].state).toBe('done')
      for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
        await postHookEvent(
          server,
          buildBody({ hook_event_name, session_id: 'nested-codex', prompt: 'Background review' }),
          '/hook/codex'
        )
        const record = sleepingRecordFromEntry({
          state: store.getState(),
          entry: store.getState().agentStatusByPaneKey[PANE],
          worktreeId: 'wt-1',
          capturedAt: Date.now()
        })
        expect(record).toMatchObject({ agent: 'claude', providerSession: { id: 'claude-parent' } })
        if (!record) {
          throw new Error('Missing foreground resume record')
        }
        expect(getAgentResumeArgv(record.agent, record.providerSession)).toEqual([
          'claude',
          '--resume',
          'claude-parent'
        ])
      }
    } finally {
      server.stop()
    }
  }
)
