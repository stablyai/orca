import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { AgentProcessPresence } from '../../../../shared/agent-process-presence'
import { buildRuntimeMobileAgentStatusProjection } from '@/runtime/sync-runtime-graph/agent-status-projection'
import { createPaneForegroundAgentTracker } from '@/components/terminal-pane/pane-foreground-agent-tracker'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const mocks = vi.hoisted((): { current: AppState | null; observe: ReturnType<typeof vi.fn> } => ({
  current: null,
  observe: vi.fn()
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.current } }))
vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observe
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
import { createAgentStatusEventApplicator } from './agent-status-event-applicator'

// The host keeps reporting its actual compatible harness after the renderer corrects presentation.
describe('compatible status continuation after process correction', () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.observe.mockReset()
  })

  it.each([false, true])(
    'settles IPC turns and the next turn across an OSC read gap (metadata=%s)',
    (metadata) => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.setState({
        refreshGitHubForWorktreeIfStale: vi.fn(),
        workspaceSessionReady: true,
        repos: [TEST_REPO],
        worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
        tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-1' })] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null
          }
        }
      })
      mocks.current = store.getState()
      const unsubscribe = store.subscribe((state) => {
        mocks.current = state
      })
      const apply = createAgentStatusEventApplicator({
        pendingAgentStatusEvents: [],
        transientClearWatermarkByConnectionId: new Map(),
        enqueuePendingAgentStatus: vi.fn()
      })
      let time = Date.now()
      const frame = (
        state: AgentStatusIpcPayload['state'],
        agentType: 'pi' | 'omp' | 'gemini' = 'pi'
      ): AgentStatusIpcPayload => ({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        state,
        agentType,
        prompt: 'task',
        receivedAt: ++time,
        stateStartedAt: time,
        ...(metadata
          ? {
              providerSession: { key: 'session_id', id: 'same-session' },
              paneOwner: { agent: 'pi', session: 'same-session' }
            }
          : {})
      })
      expect(apply(frame('working'))).toBe('applied')
      store.getState().setPaneForegroundAgent(PANE, {
        agent: 'omp',
        agentEvidence: 'process-read',
        shellForeground: false
      })
      const before = store.getState()
      expect(
        before.correctAgentStatusIdentity(
          PANE,
          before.agentStatusByPaneKey[PANE],
          before.paneForegroundAgentByPaneKey[PANE]
        )
      ).toBe(true)
      expect(mocks.observe).toHaveBeenCalledTimes(1)
      expect(store.getState().agentStatusByPaneKey[PANE].agentType).toBe('omp')
      expect(apply(frame('waiting'))).toBe('applied')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => 'pty-1',
        isTrackablePtyId: () => true,
        readForegroundProcess: async () => null,
        publish: (entry) => store.getState().setPaneForegroundAgent(PANE, entry),
        getPublishedEntry: () => store.getState().paneForegroundAgentByPaneKey[PANE]
      })
      // Actual OSC start temporarily clears local foreground proof before its confirmation settles.
      tracker.onCommandStarted(true)
      expect(store.getState().paneForegroundAgentByPaneKey[PANE].agent).toBeNull()
      expect(apply(frame('done'))).toBe('applied')
      expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
        agentType: 'omp',
        terminalTitle: expect.stringContaining('OMP'),
        state: 'done'
      })
      expect(apply(frame('working'))).toBe('applied')
      expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
        agentType: 'omp',
        terminalTitle: expect.stringContaining('OMP'),
        state: 'working'
      })
      expect(
        buildRuntimeMobileAgentStatusProjection(store.getState().agentStatusByPaneKey)
      ).toContain('"agentType":"omp"')
      expect(mocks.observe).toHaveBeenCalledTimes(4)
      expect(mocks.observe.mock.calls.slice(1).map(([event]) => event.payload.agentType)).toEqual([
        'omp',
        'omp',
        'omp'
      ])
      expect(apply(frame('done', 'gemini'))).toBe('dropped')
      expect(mocks.observe).toHaveBeenCalledTimes(4)
      tracker.dispose()
      unsubscribe()
    }
  )

  it('uses the same policy for standalone/batched reverse correction and retains raw process admission', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const set = (agentType: 'pi' | 'omp', state: 'working' | 'done' = 'working') =>
      store
        .getState()
        .setAgentStatus(
          PANE,
          { agentType, state, prompt: 'task' },
          agentType === 'omp' ? 'OMP ready' : 'Pi ready'
        )
    set('omp')
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'pi',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    const before = store.getState()
    before.correctAgentStatusIdentity(
      PANE,
      before.agentStatusByPaneKey[PANE],
      before.paneForegroundAgentByPaneKey[PANE]
    )
    set('omp', 'done')
    expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
      agentType: 'pi',
      terminalTitle: 'Pi ready',
      state: 'done'
    })
    expect(
      store
        .getState()
        .setAgentStatuses([
          { paneKey: PANE, payload: { agentType: 'omp', state: 'working', prompt: 'next' } }
        ])
    ).toEqual([true])
    expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
      agentType: 'pi',
      state: 'working'
    })
    const row = store.getState().agentStatusByPaneKey[PANE]
    const owner: AgentProcessPresence = {
      agent: 'pi',
      process: { pid: 1234, platform: 'linux', startTime: 'real-start' },
      sessionOwner: true
    }
    store
      .getState()
      .setAgentStatus(
        PANE,
        { agentType: 'omp', state: 'done', prompt: 'foreign' },
        undefined,
        undefined,
        undefined,
        { paneOwner: owner }
      )
    expect(store.getState().agentStatusByPaneKey[PANE]).toBe(row)
  })
})
