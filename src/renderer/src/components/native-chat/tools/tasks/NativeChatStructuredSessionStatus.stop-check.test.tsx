// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { WorkerDockSnapshot } from '../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import { NativeChatWorkerDockFrame } from './dock/NativeChatWorkerDockFrame'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
  party: 'party-synthetic',
  available: true,
  rows: [] as WorkerDockRowView[],
  // The feed's identities can move ahead of its row detail (a metadata-only update).
  identities: null as WorkerDockSnapshot['identities'] | null
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: hoisted.rpc }))
vi.mock('../../worker-approvals/native-chat-worker-approval-feed', () => ({
  useNativeChatPinnedWorkerApprovals: () => []
}))
vi.mock('./dock/worker-dock-feed', () => ({
  useWorkerDockFeed: () => ({
    party: hoisted.party,
    available: hoisted.available,
    rows: new Map(hoisted.rows.map((row) => [row.id, row])),
    snapshot: {
      identities:
        hoisted.identities ??
        hoisted.rows.map(
          ({ id, dispatchId, state, changedAt, settlement, ownerActionsAvailable }) => ({
            id,
            dispatchId,
            state,
            changedAt,
            settlement,
            ownerActionsAvailable,
            hasModel: false
          })
        )
    },
    loadWindow: async () => {}
  })
}))

const worker: WorkerDockRowView = {
  id: 'home/source/worker/slot-1',
  dispatchId: 'attempt-1',
  source: 'source',
  kind: 'worker',
  name: 'Verifier',
  title: 'Review journal',
  model: null,
  state: 'running',
  changedAt: null,
  startedAt: null,
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
}
const STOP = 'Stop Verifier · Review journal'

const tasks: StructuredSessionBackgroundTasksView = {
  show: true,
  isMonitoring: true,
  tasks: [],
  settledTasks: [],
  supportsStop: true,
  offersStopAll: false,
  incomplete: false
}

function tree() {
  return (
    <TooltipProvider>
      <NativeChatWorkerDockFrame>
        <NativeChatStructuredSessionStatus
          sessionId="session-synthetic"
          target={{ kind: 'local' }}
          paneKey="pane-synthetic"
          isVisible
          backgroundTasks={tasks}
          stop={{ stoppingTaskIds: new Set(), stoppingAll: false, onStop: vi.fn() }}
        />
      </NativeChatWorkerDockFrame>
    </TooltipProvider>
  )
}

function renderDock() {
  const view = render(tree())
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return { update: () => view.rerender(tree()) }
}

const stopCalls = () =>
  hoisted.rpc.mock.calls.filter(([, method]) => method === 'orchestration.workerDockStop')

/** Press Stop, let it fail once, and return to the failure's Retry. */
async function failFirstStop() {
  hoisted.rpc.mockImplementation(async (_target, method) => {
    if (method === 'orchestration.workerDockStop' && stopCalls().length === 1) {
      throw new Error('Connection dropped')
    }
    return {}
  })
  const dock = renderDock()
  fireEvent.click(screen.getByRole('button', { name: STOP }))
  await screen.findByText('Connection dropped')
  return dock
}

beforeEach(() => {
  hoisted.rpc.mockReset()
  hoisted.rpc.mockResolvedValue({})
  hoisted.party = 'party-synthetic'
  hoisted.available = true
  hoisted.rows = [worker]
  hoisted.identities = null
})
afterEach(cleanup)

it('retries a failed Stop while the worker can still stop', async () => {
  await failFirstStop()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {})
  expect(stopCalls()).toHaveLength(2)
})

it('sends no Retry Stop once a metadata-only update settled the worker', async () => {
  const dock = await failFirstStop()
  // The identity settles; the row detail still reads as a stoppable running worker.
  hoisted.identities = [
    {
      id: worker.id,
      dispatchId: worker.dispatchId,
      state: 'unexpected',
      changedAt: null,
      settlement: 'settled:attempt-1',
      ownerActionsAvailable: true,
      hasModel: false
    }
  ]
  dock.update()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Already stopped')).toBeInTheDocument()
  expect(screen.queryByText('Worker status unavailable')).toBeNull()
  expect(stopCalls()).toHaveLength(1)
})

it('sends no Retry Stop for the old dispatch once another worker holds its row', async () => {
  const dock = await failFirstStop()
  hoisted.identities = [
    {
      id: worker.id,
      dispatchId: 'attempt-2',
      state: 'running',
      changedAt: null,
      settlement: null,
      ownerActionsAvailable: true,
      hasModel: false
    }
  ]
  dock.update()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText("Can't stop now")
  expect(stopCalls()).toHaveLength(1)
})

it('sends no Retry Stop after reconnecting to another party', async () => {
  const dock = await failFirstStop()
  hoisted.party = 'party-reconnected'
  dock.update()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText("Can't stop now")
  expect(stopCalls()).toHaveLength(1)
})

function outageAndRecovery(dock: { update: () => void }) {
  hoisted.available = false
  dock.update()
  hoisted.available = true
  dock.update()
}

it('sends Stop for a held mouse press with no outage', () => {
  renderDock()
  const stop = screen.getByRole('button', { name: STOP })
  fireEvent.pointerDown(stop, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(stop, { button: 0, pointerId: 1 })
  fireEvent.click(stop)
  expect(stopCalls()).toHaveLength(1)
})

it('cancels a held mouse press on Stop when the feed drops, even if it recovers before release', async () => {
  const dock = renderDock()
  const stop = screen.getByRole('button', { name: STOP })
  fireEvent.pointerDown(stop, { button: 0, pointerId: 1 })
  outageAndRecovery(dock)
  fireEvent.pointerUp(stop, { button: 0, pointerId: 1 })
  fireEvent.click(stop)
  await act(async () => {})
  expect(stopCalls()).toHaveLength(0)
  // After release, a fresh press stops it.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const fresh = screen.getByRole('button', { name: STOP })
  fireEvent.pointerDown(fresh, { button: 0, pointerId: 2 })
  fireEvent.pointerUp(fresh, { button: 0, pointerId: 2 })
  fireEvent.click(fresh)
  expect(stopCalls()).toHaveLength(1)
})

it('cancels a held Space press on Stop when the feed drops, even if it recovers before release', async () => {
  const dock = renderDock()
  const stop = screen.getByRole('button', { name: STOP })
  fireEvent.keyDown(stop, { key: ' ' })
  outageAndRecovery(dock)
  fireEvent.keyUp(stop, { key: ' ' })
  fireEvent.click(stop)
  await act(async () => {})
  expect(stopCalls()).toHaveLength(0)
})
