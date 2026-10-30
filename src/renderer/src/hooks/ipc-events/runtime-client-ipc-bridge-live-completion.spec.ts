import { getDefaultSettings } from '../../../../shared/constants'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as terminalNotifications from '../../components/terminal-pane/use-notification-dispatch'
import { AGENT_DONE_QUIET_MS } from '../../../../shared/agent-transitions'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../../components/terminal-pane/agent-task-complete-policy'
import { COMMAND_CODE_OUTPUT_DONE_SETTLE_MS } from '../../components/terminal-pane/command-code-done-settle'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getTerminalSemanticResident } from '../../components/terminal-pane/terminal-side-effect-facts-handler'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { RuntimeClientEventBridgeHarness } from './runtime-client-ipc-bridge-ownership.test'

export function registerLiveTerminalSourceCompletionTests(
  createHarness: () => RuntimeClientEventBridgeHarness
): void {
  it.each([
    { renew: false, settled: true },
    { renew: true, settled: true },
    { renew: true, settled: false }
  ])(
    'R4 preserves a stamped first live completion across the source cut: %j',
    async ({ renew, settled }) => {
      const h = createHarness()
      const dispatch = vi
        .spyOn(terminalNotifications, 'dispatchTerminalNotification')
        .mockReturnValue(true)
      const leafId = '11111111-1111-4111-8111-111111111111'
      const paneKey = `tab:${leafId}`
      const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
      useAppStore.setState({
        settings: { ...getDefaultSettings('/home/test'), ...useAppStore.getState().settings },
        fetchHostWorkspaceStatuses: vi.fn(async () => {}),
        ptyIdsByTabId: { tab: [ptyId] },
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: ptyId }
          }
        }
      })
      const source = new TerminalSnapshotState()
      source.record(
        { kind: 'agent-status', payload: { state: 'working', agentType: 'claude', prompt: '' } },
        Date.now()
      )
      const { OrcaRuntimeService } = await import('../../../../main/runtime/orca-runtime')
      const runtime = new OrcaRuntimeService()
      let unsubscribe: (() => void) | undefined
      try {
        h.start()
        h.emit(0, false, {
          type: 'ready',
          subscriptionId: 'sub-0',
          snapshot: {
            terminalSideEffects: [
              {
                ptyId: 'physical',
                paneKey,
                tabId: 'tab',
                worktreeId: 'remote-wt',
                seq: 0,
                facts: [],
                replay: true,
                terminalState: {
                  runtimeId: renew ? 'old-runtime' : runtime.getRuntimeId(),
                  incarnationId: 'incarnation',
                  snapshot: source.snapshot()
                }
              }
            ]
          }
        })
        const resident = getTerminalSemanticResident(ptyId)!
        expect(resident.policy.completion.canAnnounceCompletion()).toBe(true)
        expect(resident.policy.completion.hasPendingHookDoneCompletion()).toBe(false)
        h.pending[0].resolve({ subscriptionId: 'sub-0', requestId: 'r' })
        for (let index = 0; index < 30; index++) {
          await Promise.resolve()
        }
        h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
        expect(h.pending).toHaveLength(2)
        if (settled) {
          h.pending[1].resolve({ subscriptionId: 'sub-1', requestId: 'r' })
          for (let index = 0; index < 30; index++) {
            await Promise.resolve()
          }
        }
        let quietDropped = false
        let liveFacts: unknown
        let lastLive: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | undefined
        let historical: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | undefined
        unsubscribe = runtime.onClientEvent(
          (event) => {
            if (event.type !== 'terminalSideEffects') {
              return
            }
            if (event.batch.replay) {
              quietDropped = true
              historical = event
              return
            }
            lastLive = event
            liveFacts = event.batch.facts
            h.emit(1, false, event)
          },
          {
            initialize: () =>
              h.emit(1, false, {
                type: 'ready',
                subscriptionId: 'sub-1',
                snapshot: {
                  terminalSideEffects: runtime.getTerminalSideEffectClientEventSnapshot()
                }
              })
          }
        )
        expect(runtime.getTerminalSideEffectClientEventSnapshot()).toEqual([])
        runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
        expect(quietDropped).toBe(true)
        const payload = {
          state: 'done' as const,
          agentType: 'claude',
          prompt: '',
          turnCompletedAt: Date.now() + 1
        }
        source.record({ kind: 'agent-status', payload }, Date.now() + 1)
        runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
        expect(liveFacts).toEqual([{ kind: 'agent-status', payload }])
        expect(getTerminalSemanticResident(ptyId)).toBe(resident)
        expect(resident.identity.runtimeId).toBe(runtime.getRuntimeId())
        expect(useAppStore.getState().agentStatusByPaneKey[paneKey]?.state).toBe('done')
        expect(resident.policy.completion.hasPendingHookDoneCompletion()).toBe(true)
        const completed = lastLive!
        expect(historical!.batch.terminalState!.snapshot.revision).toBeLessThan(
          completed.batch.terminalState!.snapshot.revision
        )
        h.emit(1, false, completed)
        h.emit(1, false, historical)
        h.emit(1, false, { ...completed, batch: { ...completed.batch, replay: true, facts: [] } })
        expect(resident.policy.completion.hasPendingHookDoneCompletion()).toBe(true)
        expect(dispatch).not.toHaveBeenCalled()
        h.pending[1].resolve({ subscriptionId: 'sub-1', requestId: 'r' })
        for (let index = 0; index < 30; index++) {
          await Promise.resolve()
        }
        await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
        expect(resident.policy.completion.hasPendingHookDoneCompletion()).toBe(false)
        expect(resident.policy.notification.hasPendingAgentTaskCompleteNotification()).toBe(true)
        await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
          'remote-wt',
          expect.objectContaining({
            source: 'agent-task-complete',
            paneKey,
            ptyId,
            agentStatusSnapshot: expect.objectContaining({
              turnCompletedAt: payload.turnCompletedAt
            })
          })
        )
        h.emit(1, false, completed)
        await vi.advanceTimersByTimeAsync(
          AGENT_DONE_QUIET_MS + AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
        )
        expect(dispatch).toHaveBeenCalledOnce()
        source.record(
          {
            kind: 'agent-status',
            payload: { state: 'working', agentType: 'claude', prompt: 'next' }
          },
          Date.now()
        )
        runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
        source.record(
          {
            kind: 'agent-status',
            payload: { ...payload, prompt: 'next', turnCompletedAt: Date.now() + 1 }
          },
          Date.now() + 1
        )
        runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
        expect(resident.policy.completion.hasPendingHookDoneCompletion()).toBe(true)
        await vi.advanceTimersByTimeAsync(
          AGENT_DONE_QUIET_MS + AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
        )
        expect(dispatch).toHaveBeenCalledTimes(2)
      } finally {
        dispatch.mockRestore()
        unsubscribe?.()
        runtime.onPtyExit('physical', 0)
        await h.finish()
      }
    }
  )

  it('keeps first-live CommandCode completion behind its real settle deadline while restoring current facets', async () => {
    const h = createHarness()
    const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab:${leafId}`
    useAppStore.setState({
      fetchHostWorkspaceStatuses: vi.fn(async () => {}),
      ptyIdsByTabId: { tab: [ptyId] },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        }
      }
    })
    const source = new TerminalSnapshotState()
    source.record({ kind: 'command-started' }, Date.now())
    source.record({ kind: 'command-code-working', prompt: 'build' }, Date.now())
    const { OrcaRuntimeService } = await import('../../../../main/runtime/orca-runtime')
    const runtime = new OrcaRuntimeService()
    let unsubscribe: (() => void) | undefined
    try {
      h.start()
      h.emit(0, false, {
        type: 'ready',
        subscriptionId: 'sub-0',
        snapshot: {
          terminalSideEffects: [
            {
              ptyId: 'physical',
              paneKey,
              tabId: 'tab',
              worktreeId: 'remote-wt',
              seq: 0,
              facts: [],
              replay: true,
              terminalState: {
                runtimeId: 'old-runtime',
                incarnationId: 'incarnation',
                snapshot: source.snapshot()
              }
            }
          ]
        }
      })
      const resident = getTerminalSemanticResident(ptyId)!
      const showTitle = vi.fn()
      const setMode2031 = vi.fn()
      const detach = resident.policy.attachPresentation({
        paneId: 1,
        isVisible: () => false,
        showTitle,
        setMode2031,
        resetInputModes: vi.fn(),
        setFocusReportSuppression: vi.fn(),
        markBracketedPasteInterrupted: vi.fn(),
        onAgentExited: vi.fn(),
        clearFocusReportSuppression: vi.fn()
      })
      const controllers = [resident.policy.commandCode, resident.policy.completion]
      const cursor = Reflect.get(resident, 'consumption')
      expect(useAppStore.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        agentType: 'command-code'
      })
      h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
      unsubscribe = runtime.onClientEvent(
        (event) => {
          if (event.type === 'terminalSideEffects' && !event.batch.replay) {
            h.emit(1, false, event)
          }
        },
        {
          initialize: () =>
            h.emit(1, false, {
              type: 'ready',
              subscriptionId: 'sub-1',
              snapshot: { terminalSideEffects: [] }
            })
        }
      )
      source.record(
        { kind: 'title', rawTitle: 'Build output', normalizedTitle: 'Build output' },
        Date.now()
      )
      source.record({ kind: '2031-subscribe' }, Date.now())
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      source.record({ kind: 'command-code-done', prompt: 'build' }, Date.now() + 1)
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(getTerminalSemanticResident(ptyId)).toBe(resident)
      expect(Reflect.get(resident, 'consumption')).toBe(cursor)
      expect(resident.policy.commandCode).toBe(controllers[0])
      expect(resident.policy.completion).toBe(controllers[1])
      expect(showTitle).toHaveBeenCalledWith('Build output', 'Build output', false)
      expect(setMode2031).toHaveBeenCalledWith(true)
      expect(useAppStore.getState().agentStatusByPaneKey[paneKey]?.state).toBe('working')
      await vi.advanceTimersByTimeAsync(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 1)
      expect(useAppStore.getState().agentStatusByPaneKey[paneKey]?.state).toBe('working')
      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        prompt: 'build',
        agentType: 'command-code'
      })
      detach()
    } finally {
      unsubscribe?.()
      runtime.onPtyExit('physical', 0)
      await h.finish()
    }
  })
}
