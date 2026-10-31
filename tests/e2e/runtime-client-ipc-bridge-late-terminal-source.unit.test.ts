import { afterEach, beforeEach } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { _resetTerminalSideEffectFactConsumersForTest } from '../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler'
import { createHarness } from '../../src/renderer/src/hooks/ipc-events/runtime-client-ipc-bridge-harness-fixture'

import { TerminalSnapshotConsumption } from '../../src/shared/terminal-snapshot-consumption'
import { TerminalSnapshotObserver } from '../../src/shared/terminal-snapshot-observer'
import { getDefaultSettings } from '../../src/shared/constants'
import { expect, it, vi } from 'vitest'
import * as terminalNotifications from '../../src/renderer/src/components/terminal-pane/use-notification-dispatch'
import { AGENT_DONE_QUIET_MS } from '../../src/shared/agent-transitions'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../../src/renderer/src/components/terminal-pane/agent-task-complete-policy'
import { useAppStore } from '@/store'
import { TerminalSnapshotState } from '../../src/shared/terminal-snapshot-state'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeClientEvent } from '../../src/shared/runtime-client-events'
import {
  getTerminalSemanticResident,
  dispatchTerminalSideEffectBatch,
  retireTerminalSemanticResident
} from '../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler'
import type { RuntimeClientEventBridgeHarness } from '../../src/renderer/src/hooks/ipc-events/runtime-client-ipc-bridge-harness-fixture'

function measuredConsumption(resident: object): TerminalSnapshotConsumption {
  const value: unknown = Object.getOwnPropertyDescriptor(resident, 'consumption')?.value
  if (!(value instanceof TerminalSnapshotConsumption)) {
    throw new Error('Expected actual resident cursor')
  }
  return value
}

function measuredParser(source: object): TerminalSnapshotObserver {
  const value: unknown = Object.getOwnPropertyDescriptor(source, 'bytes')?.value
  if (!(value instanceof TerminalSnapshotObserver)) {
    throw new Error('Expected actual legacy parser')
  }
  return value
}

export function registerLateTerminalSourceRetryTest(
  createHarness: () => RuntimeClientEventBridgeHarness
): void {
  it('R3 completes failed setup retry, installed empty ready and a first live companion after dropped quiet state', async () => {
    const h = createHarness()
    const markTerminalBell = vi.fn()
    const dispatch = vi
      .spyOn(terminalNotifications, 'dispatchTerminalNotification')
      .mockReturnValue(true)
    const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab:${leafId}`
    useAppStore.setState({
      markTerminalBell,
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
    const { OrcaRuntimeService } = await import('../../src/main/runtime/orca-runtime')
    const runtime = new OrcaRuntimeService()
    let unsubscribe: (() => void) | undefined
    let stopped = false
    try {
      const stop = h.start()
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
      const policy = resident.policy
      const parser = measuredParser(policy.legacySource)
      const cursor = measuredConsumption(resident)
      h.pending[0].resolve({ subscriptionId: 'sub-0', requestId: 'r' })
      for (let index = 0; index < 30; index++) {
        await Promise.resolve()
      }
      h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
      expect(h.pending).toHaveLength(2)
      h.pending[1].reject(new Error('actual setup failure'))
      for (let index = 0; index < 30; index++) {
        await Promise.resolve()
      }
      expect(h.ipc.removeListener).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1001)
      expect(h.pending).toHaveLength(3)
      // Obsolete setup cannot reinstall or deliver after the retry has dispatched.
      h.emit(1, false, {
        type: 'ready',
        subscriptionId: 'sub-1',
        snapshot: { terminalSideEffects: [] }
      })
      h.pending[2].resolve({ subscriptionId: 'sub-2', requestId: 'r' })
      for (let index = 0; index < 30; index++) {
        await Promise.resolve()
      }
      let dropped = false
      let live: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | undefined
      unsubscribe = runtime.onClientEvent(
        (event) => {
          if (event.type !== 'terminalSideEffects') {
            return
          }
          if (event.batch.replay) {
            dropped = true
            return
          }
          live = event
          h.emit(2, false, event)
        },
        {
          initialize: () =>
            h.emit(2, false, {
              type: 'ready',
              subscriptionId: 'sub-2',
              snapshot: {
                terminalSideEffects: runtime.getTerminalSideEffectClientEventSnapshot()
              }
            })
        }
      )
      expect(runtime.getTerminalSideEffectClientEventSnapshot()).toEqual([])
      const forged = {
        ptyId,
        seq: 0,
        facts: [],
        replay: true,
        terminalState: {
          runtimeId: 'forged',
          incarnationId: 'incarnation',
          snapshot: source.snapshot()
        }
      }
      dispatchTerminalSideEffectBatch(forged)
      h.emit(2, false, {
        type: 'terminalSideEffects',
        batch: {
          ...forged,
          ptyId: 'physical',
          terminalState: {
            ...forged.terminalState,
            incarnationId: 'foreign-incarnation'
          }
        }
      })
      expect(resident.identity.runtimeId).toBe('old-runtime')
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(dropped).toBe(true)
      const payload = {
        state: 'done' as const,
        agentType: 'claude',
        prompt: '',
        turnCompletedAt: Date.now() + 1
      }
      source.record({ kind: 'agent-status', payload }, Date.now() + 1)
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(live?.batch.facts).toEqual([{ kind: 'agent-status', payload }])
      expect(policy.completion.hasPendingHookDoneCompletion()).toBe(true)
      const firstLive = live!
      source.record({ kind: 'bell' }, Date.now() + 2)
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(live?.batch.facts).toEqual([{ kind: 'bell' }])
      expect(markTerminalBell).toHaveBeenCalledOnce()
      expect(getTerminalSemanticResident(ptyId)).toBe(resident)
      expect(resident.policy).toBe(policy)
      expect(measuredParser(resident.policy.legacySource)).toBe(parser)
      expect(measuredConsumption(resident)).toBe(cursor)
      expect(resident.identity.runtimeId).toBe(runtime.getRuntimeId())
      // The postbatch cursor fences duplicates/lower state and an arbitrary runtime after installation.
      h.emit(2, false, live)
      dispatchTerminalSideEffectBatch(forged)
      expect(markTerminalBell).toHaveBeenCalledOnce()
      expect(policy.completion.hasPendingHookDoneCompletion()).toBe(true)
      await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
      expect(policy.notification.hasPendingAgentTaskCompleteNotification()).toBe(true)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        'remote-wt',
        expect.objectContaining({
          source: 'agent-task-complete',
          paneKey,
          ptyId,
          agentStatusSnapshot: expect.objectContaining({ turnCompletedAt: payload.turnCompletedAt })
        })
      )
      source.record({ kind: 'bell' }, Date.now() + 1)
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(markTerminalBell).toHaveBeenCalledTimes(2)
      expect(firstLive.batch.terminalState!.snapshot.revision).toBeLessThan(
        live!.batch.terminalState!.snapshot.revision
      )
      h.emit(2, false, firstLive)
      expect(markTerminalBell).toHaveBeenCalledTimes(2)
      stop()
      stopped = true
      source.record({ kind: 'bell' }, Date.now() + 2)
      runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
      expect(markTerminalBell).toHaveBeenCalledTimes(2)
      expect(h.ipc.invoke).toHaveBeenCalledWith('runtimeEnvironments:unsubscribe', {
        subscriptionId: 'sub-2'
      })
      retireTerminalSemanticResident(ptyId, 'incarnation')
      expect(resident.isLive).toBe(false)
      dispatchTerminalSideEffectBatch({
        ...forged,
        terminalState: { ...forged.terminalState, runtimeId: runtime.getRuntimeId() }
      })
      expect(markTerminalBell).toHaveBeenCalledTimes(2)
    } finally {
      dispatch.mockRestore()
      unsubscribe?.()
      runtime.onPtyExit('physical', 0)
      await h.finish()
    }
    expect(stopped).toBe(true)
  })
}

const initialState = useAppStore.getState()

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  _resetTerminalSideEffectFactConsumersForTest()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions(initialState.runtimeEnvironments)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

registerLateTerminalSourceRetryTest(createHarness)
