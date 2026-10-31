import type { TerminalResidentLegacySource } from '../../src/renderer/src/components/terminal-pane/terminal-resident-legacy-source'
import type { TerminalSemanticResident } from '../../src/renderer/src/components/terminal-pane/terminal-semantic-residents'
import { expect, it, vi, afterEach, beforeEach } from 'vitest'
import { useAppStore } from '@/store'
import { TerminalSnapshotConsumption } from '../../src/shared/terminal-snapshot-consumption'
import { TerminalSnapshotObserver } from '../../src/shared/terminal-snapshot-observer'
import { TerminalSnapshotState } from '../../src/shared/terminal-snapshot-state'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime/remote-runtime-pty-id'
import {
  getTerminalSemanticResident,
  _resetTerminalSideEffectFactConsumersForTest
} from '../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler'
import type { RuntimeClientEvent } from '../../src/shared/runtime-client-events'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { createHarness } from '../../src/renderer/src/hooks/ipc-events/runtime-client-ipc-bridge-harness-fixture'

const initialState = useAppStore.getState()

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  _resetTerminalSideEffectFactConsumersForTest()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions(initialState.runtimeEnvironments)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function measuredConsumption(resident: TerminalSemanticResident): TerminalSnapshotConsumption {
  const value: unknown = Object.getOwnPropertyDescriptor(resident, 'consumption')?.value
  if (!(value instanceof TerminalSnapshotConsumption)) {
    throw new Error('Expected actual resident cursor')
  }
  return value
}

function measuredParser(source: TerminalResidentLegacySource): TerminalSnapshotObserver {
  const value: unknown = Object.getOwnPropertyDescriptor(source, 'bytes')?.value
  if (!(value instanceof TerminalSnapshotObserver)) {
    throw new Error('Expected actual legacy parser')
  }
  return value
}

it('R3 keeps a same-incarnation execution when restarted host state arrives after an empty capable ready', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({ markTerminalBell, fetchHostWorkspaceStatuses: vi.fn(async () => {}) })
  const source = new TerminalSnapshotState()
  const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
  const { OrcaRuntimeService } = await import('../../src/main/runtime/orca-runtime')
  const runtime = new OrcaRuntimeService()
  let unsubscribe: (() => void) | undefined
  const produced: RuntimeClientEvent[] = []
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: {
        terminalSideEffects: [
          {
            ptyId: 'physical',
            paneKey: 'tab:leaf',
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
    const resident = getTerminalSemanticResident(ptyId)
    expect(resident).toBeDefined()
    const cursor = resident && measuredConsumption(resident)
    const policy = resident!.policy
    const parser = measuredParser(policy.legacySource)
    const controllers = [
      policy.legacySource,
      policy.input,
      policy.completion,
      policy.notification,
      policy.foreground,
      policy.commandCode
    ]
    const restore = vi.spyOn(policy, 'restoreCurrent')
    const effects = vi.spyOn(policy, 'applyEffect')
    h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
    expect(h.pending).toHaveLength(2)
    unsubscribe = runtime.onClientEvent(
      (event) => {
        produced.push(event)
        h.emit(1, false, event)
      },
      {
        initialize: () =>
          h.emit(1, false, {
            type: 'ready',
            subscriptionId: 'sub-1',
            snapshot: { terminalSideEffects: runtime.getTerminalSideEffectClientEventSnapshot() }
          })
      }
    )
    expect(runtime.getTerminalSideEffectClientEventSnapshot()).toEqual([])
    runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
    expect(markTerminalBell).not.toHaveBeenCalled()
    expect(effects).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith(expect.anything(), true, true, undefined, [])
    source.record({ kind: 'bell' }, Date.now())
    runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
    expect(produced.filter((event) => event.type === 'terminalSideEffects')).toHaveLength(2)
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(resident && measuredConsumption(resident)).toBe(cursor)
    expect(produced[0]).toMatchObject({
      type: 'terminalSideEffects',
      batch: {
        replay: true,
        terminalState: { incarnationId: 'incarnation' }
      }
    })
    expect(produced[1]).toMatchObject({
      type: 'terminalSideEffects',
      batch: {
        terminalState: {
          incarnationId: 'incarnation',
          snapshot: { effects: { bell: { count: 1 } } }
        }
      }
    })
    expect.soft(markTerminalBell).toHaveBeenCalledOnce()
    expect(resident!.policy).toBe(policy)
    expect(measuredParser(policy.legacySource)).toBe(parser)
    ;[
      policy.legacySource,
      policy.input,
      policy.completion,
      policy.notification,
      policy.foreground,
      policy.commandCode
    ].forEach((controller, index) => expect(controller).toBe(controllers[index]))
    expect(effects).toHaveBeenCalledOnce()
    // Control: the same actual producer frames deliver if only the runtime ID matches.
    for (const event of produced) {
      if (event.type === 'terminalSideEffects' && event.batch.terminalState) {
        h.emit(1, false, {
          ...event,
          batch: {
            ...event.batch,
            terminalState: {
              ...event.batch.terminalState,
              runtimeId: 'old-runtime'
            }
          }
        })
      }
    }
    expect(markTerminalBell).toHaveBeenCalledOnce()
  } finally {
    unsubscribe?.()
    runtime.onPtyExit('physical', 0)
    await h.finish()
  }
})
