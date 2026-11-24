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

const hoisted = vi.hoisted(() => {
  const state: {
    rpc: ReturnType<
      typeof vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>
    >
    party: string
    available: boolean
    rows: WorkerDockRowView[]
    // The feed's identities can move ahead of its row detail (a metadata-only update).
    identities: WorkerDockSnapshot['identities'] | null
    // The feed's live loss count, which moves at publication, before React renders.
    losses: number
  } = {
    rpc: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    party: 'party-synthetic',
    available: true,
    rows: [],
    identities: null,
    losses: 0
  }
  return state
})
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
    loadWindow: async () => {},
    readLosses: () => hoisted.losses
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

function identity(patch: Partial<WorkerDockSnapshot['identities'][number]>) {
  return {
    id: worker.id,
    dispatchId: worker.dispatchId,
    state: worker.state,
    changedAt: null,
    settlement: null,
    ownerActionsAvailable: true,
    hasModel: false,
    ...patch
  }
}

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

async function pressRetry() {
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {})
}

beforeEach(() => {
  hoisted.rpc.mockReset()
  hoisted.rpc.mockResolvedValue({})
  hoisted.party = 'party-synthetic'
  hoisted.available = true
  hoisted.rows = [worker]
  hoisted.identities = null
  hoisted.losses = 0
})
afterEach(cleanup)

it('retries a failed Stop with the same request id while the worker can still stop', async () => {
  await failFirstStop()
  await pressRetry()
  const calls = stopCalls()
  expect(calls).toHaveLength(2)
  expect(calls[1][2]).toEqual(calls[0][2])
})

// A ready worker whose activity the host can't verify, and a launch whose outcome was never
// seen, both read as unavailable with an explicit stoppable detail on a live feed.
it.each([
  ['ready with unverified activity', { changedAt: 1_795_000_000_000 }],
  ['start unknown', { changedAt: null }]
])('stops a %s worker on a live feed, first press and Retry', async (_name, patch) => {
  hoisted.rows = [{ ...worker, ...patch, state: 'unavailable' }]
  await failFirstStop()
  await pressRetry()
  expect(stopCalls()).toHaveLength(2)
  expect(screen.queryByText("Can't stop now")).toBeNull()
})

it('sends no Stop for an unavailable worker once the feed itself is offline', async () => {
  hoisted.rows = [{ ...worker, state: 'unavailable' }]
  const dock = await failFirstStop()
  hoisted.available = false
  hoisted.losses++
  dock.update()
  await pressRetry()
  expect(await screen.findByText("Can't stop now")).toBeInTheDocument()
  expect(stopCalls()).toHaveLength(1)
  // The offline row offers no Stop to press either.
  expect(screen.queryByRole('button', { name: /^Stop Verifier/ })).toBeNull()
})

it('sends no Retry Stop once a metadata-only update settled the worker', async () => {
  const dock = await failFirstStop()
  // The identity settles; the row detail still reads as a stoppable running worker.
  hoisted.identities = [identity({ state: 'unexpected', settlement: 'settled:attempt-1' })]
  dock.update()
  await pressRetry()
  expect(await screen.findByText('Already stopped')).toBeInTheDocument()
  expect(screen.queryByText('Worker status unavailable')).toBeNull()
  // A settled worker can't be stopped again, so the line offers no Retry.
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(stopCalls()).toHaveLength(1)
})

it('reads Already stopped when the settled worker has no cached detail, and keeps focus', async () => {
  const dock = await failFirstStop()
  hoisted.rows = []
  hoisted.identities = [identity({ state: 'failed', settlement: 'settled:attempt-1' })]
  dock.update()
  const retry = screen.getByRole('button', { name: 'Retry' })
  retry.focus()
  fireEvent.click(retry)
  expect(await screen.findByText('Already stopped')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus()
  expect(stopCalls()).toHaveLength(1)
})

it('sends no Retry Stop once the current identity is stopping, even with stale stoppable detail', async () => {
  const dock = await failFirstStop()
  hoisted.identities = [identity({ state: 'stopping' })]
  dock.update()
  await pressRetry()
  expect(await screen.findByText("Can't stop now")).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(stopCalls()).toHaveLength(1)
})

it('sends no Retry Stop for the old dispatch once another worker holds its row', async () => {
  const dock = await failFirstStop()
  hoisted.identities = [identity({ dispatchId: 'attempt-2' })]
  dock.update()
  await pressRetry()
  await screen.findByText("Can't stop now")
  expect(stopCalls()).toHaveLength(1)
})

it('sends no Retry Stop after reconnecting to another party', async () => {
  const dock = await failFirstStop()
  hoisted.party = 'party-reconnected'
  dock.update()
  await pressRetry()
  await screen.findByText("Can't stop now")
  expect(stopCalls()).toHaveLength(1)
})

function outageAndRecovery(dock: { update: () => void }) {
  hoisted.available = false
  hoisted.losses++
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

it('keeps a held Space press cancelled across an unrelated pointer release', async () => {
  const dock = renderDock()
  const stop = screen.getByRole('button', { name: STOP })
  stop.focus()
  fireEvent.keyDown(stop, { key: ' ' })
  // A click elsewhere that keeps focus on Stop ends the dock's own hold before Space is released.
  fireEvent.pointerDown(document.body, { button: 0, pointerId: 3 })
  fireEvent.pointerUp(document.body, { button: 0, pointerId: 3 })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  outageAndRecovery(dock)
  fireEvent.keyUp(stop, { key: ' ' })
  fireEvent.click(stop)
  await act(async () => {})
  expect(stopCalls()).toHaveLength(0)
})

it('cancels a held Space press when a loss and recovery are published before React renders', async () => {
  renderDock()
  const stop = screen.getByRole('button', { name: STOP })
  fireEvent.keyDown(stop, { key: ' ' })
  // Both publications land before any render: only the feed's live loss count moved.
  hoisted.losses++
  fireEvent.keyUp(stop, { key: ' ' })
  fireEvent.click(stop)
  await act(async () => {})
  expect(stopCalls()).toHaveLength(0)
})
