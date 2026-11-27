// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'

const hoisted = vi.hoisted(() => {
  const PERSON = 'orchestration.person-approvals.v1'
  const workers: WorkerDockRowView[] = []
  return {
    rpc: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    workers,
    pairedDockOwner: false,
    clientCapabilities: [PERSON]
  }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: hoisted.rpc }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (_environmentId: string, capability: string) =>
    capability === 'orchestration.paired-worker-dock-owner.v1' && hoisted.pairedDockOwner
}))
vi.mock('@/runtime/rpc/targets/paired-host-client-capabilities', () => ({
  pairedHostClientCapabilities: () => hoisted.clientCapabilities
}))
vi.mock('../../worker-approvals/native-chat-worker-approval-feed', () => ({
  useNativeChatPinnedWorkerApprovals: () => []
}))
vi.mock('./dock/worker-dock-feed', () => ({
  useWorkerDockFeed: () => {
    const rows = hoisted.workers
    return {
      party: 'party-synthetic',
      available: true,
      rows: new Map(rows.map((row) => [row.id, row])),
      snapshot: { identities: rows },
      loadWindow: async () => {},
      readLosses: () => 0
    }
  }
}))

const REMOTE: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-paired-synthetic' }
const LOCAL: RuntimeClientTarget = { kind: 'local' }

const worker: WorkerDockRowView = {
  id: 'home/source/worker/attempt-1',
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

const commandTasks: StructuredSessionBackgroundTasksView = {
  show: true,
  isMonitoring: true,
  tasks: [{ id: 'shell-7', kind: 'command', description: 'Run the build', state: 'working' }],
  settledTasks: [],
  supportsStop: true,
  offersStopAll: false,
  incomplete: false
}

function renderStrip(target: RuntimeClientTarget, onStop = vi.fn()) {
  render(
    <TooltipProvider>
      <NativeChatStructuredSessionStatus
        sessionId="session-synthetic"
        target={target}
        paneKey="pane-synthetic"
        isVisible
        backgroundTasks={commandTasks}
        stop={{ stoppingTaskIds: new Set(), stoppingAll: false, onStop }}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return onStop
}

beforeEach(() => {
  hoisted.rpc.mockReset()
  hoisted.rpc.mockResolvedValue({})
  hoisted.workers = []
  hoisted.pairedDockOwner = false
  hoisted.clientCapabilities = ['orchestration.person-approvals.v1']
})
afterEach(cleanup)

it.each([
  ['remote', REMOTE],
  ['local', LOCAL]
])("sends a %s chat's background-command Stop to the chat's own session", (_name, target) => {
  const onStop = renderStrip(target)
  const button = screen.getByRole('button', { name: /^Stop Command · Run the build$/ })
  expect(button).not.toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(button)
  expect(onStop).toHaveBeenCalledWith('shell-7')
})

const failed: WorkerDockRowView = {
  ...worker,
  id: 'home/source/worker/attempt-2',
  dispatchId: 'attempt-2',
  name: 'Cleaner',
  title: 'Clean up journal',
  state: 'failed',
  reason: 'Cleanup failed',
  settlement: 'settlement-2',
  stoppable: false
}

it("keeps a remote chat's orchestration worker Open-only on a host that refuses this window's Clear and Stop", () => {
  hoisted.workers = [worker, failed]
  const onStop = renderStrip(REMOTE)
  expect(screen.queryByRole('button', { name: /^Stop Verifier/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Clear Cleaner/ })).toBeNull()
  const open = screen.getByRole('button', { name: /^Worker · Review journal/ })
  expect(open).toHaveAccessibleName(/from the computer it runs on/)
  expect(onStop).not.toHaveBeenCalled()
  expect(hoisted.rpc).not.toHaveBeenCalledWith(
    expect.anything(),
    'orchestration.workerDockStop',
    expect.anything()
  )
})

it("clears a paired host's settled failure from this window once the host takes it", async () => {
  hoisted.pairedDockOwner = true
  hoisted.workers = [worker, failed]
  renderStrip(REMOTE)
  const clear = await screen.findByRole('button', { name: 'Clear Cleaner' })
  expect(screen.getByRole('button', { name: /^Stop Verifier · Review journal$/ })).toBeVisible()
  expect(screen.queryByText(/from the computer it runs on/)).toBeNull()
  fireEvent.click(clear)
  await waitFor(() =>
    expect(hoisted.rpc).toHaveBeenCalledWith(REMOTE, 'orchestration.workerDockAcknowledge', {
      party: 'party-synthetic',
      settlements: [{ dispatchId: 'attempt-2', settlement: 'settlement-2' }],
      acknowledged: true
    })
  )
})

it.each([
  ['a client the host does not count as a person', [], failed],
  [
    'a worker running on another computer',
    ['orchestration.person-approvals.v1'],
    { ...failed, ownerActionsAvailable: false }
  ]
])("keeps a paired host's failure Open-only for %s", async (_name, capabilities, row) => {
  hoisted.pairedDockOwner = true
  hoisted.clientCapabilities = capabilities
  hoisted.workers = [row]
  renderStrip(REMOTE)
  const open = screen.getByRole('button', { name: /^Worker · Clean up journal/ })
  // Let the host's capability answer arrive before checking the row stayed Open-only.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByRole('button', { name: /^Clear Cleaner/ })).toBeNull()
  expect(open).toHaveAccessibleName(/from the computer it runs on/)
})
