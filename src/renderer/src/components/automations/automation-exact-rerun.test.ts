import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationsPageActionContext } from './automations-page-action-context'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import { makeAutomationListRow, makeRun } from './automations-page-fixtures'
import { createAutomationRunActions } from './automation-run-actions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn(),
  hasRuntimeRpcErrorCode: () => false
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./automation-run-view-state', () => ({
  waitForAutomationRerunPendingVisibility: async () => {}
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

function fixture(owner?: AutomationCapturedOwner) {
  const row = makeAutomationListRow()
  const reportOwnerAction = vi.fn()
  const context = {
    store: {},
    local: {
      rerunRunIdsInFlightRef: { current: new Set<string>() },
      setRerunRunIdsInFlight: vi.fn(),
      setSelectedAutomationRuns:
        vi.fn<AutomationsPageActionContext['local']['setSelectedAutomationRuns']>()
    },
    destination: {
      automationHostTargetFor: () => ({ kind: 'local' }),
      automationDispatchContext: {
        capturedOwners: new Map(owner ? [[row.key, owner]] : []),
        authority: { kind: 'desktop' }
      },
      reportOwnerAction,
      invalidateRowHost: vi.fn()
    },
    sourceAvailability: {},
    pageRefresh: {
      hydratePersistedUIState: vi.fn(),
      refresh: vi.fn(),
      invalidateSelectedRunHistory: vi.fn()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the collaborators used by the rerun handler are exercised in this unit fixture.
  const actions = createAutomationRunActions(context as unknown as AutomationsPageActionContext)
  return { row, actions, reportOwnerAction, local: context.local, pageRefresh: context.pageRefresh }
}

describe('Rerun selection', () => {
  it('passes the clicked historical run through the unfenced desktop path', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ run: makeRun({ id: 'retry' }) })
    const { actions, row } = fixture()
    await actions.rerunAutomationRun(row, makeRun({ id: 'monday', status: 'dispatch_failed' }))
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'automation.rerun',
      { id: row.automation.id, runId: 'monday' },
      { timeoutMs: 15_000 }
    )
  })

  it('keeps the captured SSH owner and selected run when the active host differs', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ run: makeRun({ id: 'retry' }) })
    const selector = { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } as const
    const { actions, row } = fixture({
      owner: { authority: { kind: 'desktop' }, selector },
      selector
    })
    await actions.rerunAutomationRun(row, makeRun({ id: 'tuesday', status: 'dispatch_failed' }))
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'automation.rerun',
      { id: row.automation.id, runId: 'tuesday', expectedOwner: { selector } },
      expect.any(Object)
    )
  })

  it('makes the queued attempt immediately openable without touching another selected owner', async () => {
    const retry = makeRun({ id: 'retry' })
    vi.mocked(callRuntimeRpc).mockResolvedValue({ run: retry })
    const { actions, row, local, pageRefresh } = fixture()
    await actions.rerunAutomationRun(row, makeRun({ id: 'monday', status: 'dispatch_failed' }))
    const update = local.setSelectedAutomationRuns.mock.calls[0][0]
    if (typeof update !== 'function') {
      throw new Error('Expected an atomic history update')
    }
    const history: SelectedAutomationRunHistoryOutcome = {
      automationId: row.automation.id,
      rowKey: row.key,
      ownerKey: 'uncaptured',
      runs: [makeRun({ id: 'monday' })],
      notice: null
    }
    expect(update(history).runs.map((run) => run.id)).toEqual(['retry', 'monday'])
    expect(update({ ...history, runs: [retry, ...history.runs] }).runs).toHaveLength(2)
    const movedOwner = { ...history, ownerKey: 'different-owner' }
    expect(update(movedOwner)).toBe(movedOwner)
    const otherRow = { ...history, rowKey: 'other-row' }
    expect(update(otherRow)).toBe(otherRow)
    expect(pageRefresh.invalidateSelectedRunHistory).toHaveBeenCalledBefore(
      local.setSelectedAutomationRuns
    )
  })

  it('surfaces an older host rejection without falling back to Run now', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Unknown method: automation.rerun'))
    const { actions, row, reportOwnerAction } = fixture()
    await actions.rerunAutomationRun(row, makeRun({ id: 'monday', status: 'dispatch_failed' }))
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    expect(reportOwnerAction).toHaveBeenCalledWith(
      row.key,
      expect.objectContaining({
        severity: 'failure',
        message: 'Unknown method: automation.rerun'
      })
    )
  })
})
