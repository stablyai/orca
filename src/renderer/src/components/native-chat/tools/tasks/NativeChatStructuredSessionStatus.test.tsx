// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'

const hoisted = vi.hoisted(() => {
  const workers: WorkerDockRowView[] = []
  return {
    rpc: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    workers
  }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: hoisted.rpc }))
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

it("keeps a remote chat's orchestration worker Open-only: no Stop that would do nothing", () => {
  hoisted.workers = [worker]
  const onStop = renderStrip(REMOTE)
  expect(screen.queryByRole('button', { name: /^Stop Verifier/ })).toBeNull()
  const open = screen.getByRole('button', { name: /^Verifier · Review journal/ })
  expect(open).toHaveAccessibleName(/from the computer it runs on/)
  expect(onStop).not.toHaveBeenCalled()
  expect(hoisted.rpc).not.toHaveBeenCalledWith(
    expect.anything(),
    'orchestration.workerDockStop',
    expect.anything()
  )
})
