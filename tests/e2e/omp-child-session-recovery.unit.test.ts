import { describe, expect, it } from 'vitest'
import { createAgentStatusExtensionHarness } from '../../src/main/pi/agent-status-extension-test-harness'
import { normalizeHookPayload } from '../../src/shared/agent-hook-listener'
import { createHookListenerState } from '../../src/shared/agent-hook-listener/listener-state'
import { getAgentResumeArgv } from '../../src/shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../src/shared/tui-agent-resume-startup'
import { sleepingAgentSessionsByPaneKeySchema } from '../../src/shared/workspace-session-sleeping-agents'
import { createTestStore, makeTab } from '../../src/renderer/src/store/slices/store-test-helpers'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const ROOT_SESSION = '22222222-2222-4222-8222-222222222222'
const CHILD_SESSION = '33333333-3333-4333-8333-333333333333'

async function rootWithActiveChild(): Promise<ReturnType<typeof createTestStore>> {
  const store = createTestStore()
  store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
  const listener = createHookListenerState()
  const harness = createAgentStatusExtensionHarness({
    kind: 'omp',
    env: {
      ORCA_PANE_KEY: PANE,
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_HOOK_VERSION: '1',
      ORCA_AGENT_HOOK_ENV: 'production'
    },
    fetchImpl: async (_url, init) => {
      const event = normalizeHookPayload(
        listener,
        'omp',
        JSON.parse(String(init?.body)),
        'production'
      )
      if (!event) {
        throw new Error('Expected a normalized OMP hook')
      }
      store
        .getState()
        .setAgentStatus(
          PANE,
          event.payload,
          'OMP',
          { updatedAt: Date.now(), stateStartedAt: Date.now() },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession: event.providerSession, launchToken: event.launchToken }
        )
      return { ok: true }
    }
  })
  const emit = async (
    name: string,
    event: unknown,
    sessionManager: {
      getSessionId: () => string
      getSessionFile: () => string
    }
  ): Promise<void> => {
    await harness.callHook(name, event, { sessionManager })
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  }
  const root = { getSessionId: () => ROOT_SESSION, getSessionFile: () => '/sessions/root.jsonl' }
  await emit('session_start', {}, root)
  await emit('before_agent_start', { prompt: 'ROOT distinctive user request' }, root)
  await emit(
    'message_end',
    { message: { role: 'assistant', content: 'ROOT assistant preview' } },
    root
  )
  expect(store.getState().agentStatusByPaneKey[PANE]?.providerSession?.id).toBe(ROOT_SESSION)

  // OMP binds each task's extension factory to a different SessionManager in the same process.
  harness.reload()
  const child = {
    getSessionId: () => CHILD_SESSION,
    getSessionFile: () => '/sessions/root/worker.jsonl'
  }
  await emit('session_start', {}, child)
  await emit('before_agent_start', { prompt: 'CHILD delegated bootstrap' }, child)
  await emit(
    'message_end',
    { message: { role: 'assistant', content: 'CHILD assistant preview' } },
    child
  )
  return store
}

describe('OMP child lifecycle recovery boundaries', () => {
  it('retains the normalized root prompt and assistant preview while its child works (#9348)', async () => {
    const store = await rootWithActiveChild()
    expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
      prompt: 'ROOT distinctive user request',
      lastAssistantMessage: 'ROOT assistant preview',
      state: 'working',
      providerSession: { id: ROOT_SESSION }
    })
  })

  it('captures and hydrates the root identity into resume startup after child hooks (#16353)', async () => {
    const store = await rootWithActiveChild()
    store.getState().captureAllSleepingAgentSessions('quit')
    const serialized = JSON.stringify(store.getState().sleepingAgentSessionsByPaneKey)
    const hydrated = sleepingAgentSessionsByPaneKeySchema.parse(JSON.parse(serialized))
    const record = hydrated?.[PANE]
    if (!record) {
      throw new Error('Expected the root sleeping record to survive hydration')
    }
    expect(record).toMatchObject({ origin: 'quit', providerSession: { id: ROOT_SESSION } })
    expect(getAgentResumeArgv(record.agent, record.providerSession)).toEqual([
      'omp',
      '--resume',
      ROOT_SESSION
    ])
    const startup = buildAgentResumeStartupPlan({
      agent: record.agent,
      providerSession: record.providerSession,
      cmdOverrides: {},
      platform: 'linux',
      ...record.launchConfig
    })
    expect(startup?.launchCommand).toBe(`omp '--resume' '${ROOT_SESSION}'`)
    expect(serialized).not.toContain(CHILD_SESSION)
  })
})
