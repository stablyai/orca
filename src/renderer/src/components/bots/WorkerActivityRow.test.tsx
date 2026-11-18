// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationSessionWorker } from '../../../../shared/orchestration-session-workers'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkerActivityRow } from './WorkerActivityRow'

const { stopOrchestrationWorker } = vi.hoisted(() => ({
  stopOrchestrationWorker: vi.fn(() => Promise.resolve())
}))
vi.mock('@/lib/stop-orchestration-worker', () => ({ stopOrchestrationWorker }))
vi.mock('@/store', () => ({ useAppStore: () => null }))

afterEach(() => {
  cleanup()
  stopOrchestrationWorker.mockClear()
})

const WORKER: OrchestrationSessionWorker = {
  dispatchId: 'ctx_1',
  taskId: 'task_1',
  runId: 'run_1',
  title: 'ranger-hello',
  agent: 'claude',
  state: 'completed',
  liveness: 'exited',
  host: 'local',
  worktreeId: null,
  paneKey: null,
  chatSessionId: null,
  startedAt: 1_000,
  settledAt: 42_000,
  summary: 'Added README.md'
}

function row(overrides: Partial<Parameters<typeof WorkerActivityRow>[0]> = {}): void {
  render(
    <TooltipProvider>
      <WorkerActivityRow
        dispatchId="ctx_1"
        title="ranger-hello"
        dot="done"
        running={false}
        origin="Started by your chat"
        coordinator="Bot builder"
        workspaceId={null}
        worker={WORKER}
        canStop
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe('WorkerActivityRow', () => {
  it('stops a running worker through the host', () => {
    row({ running: true, dot: 'working', worker: { ...WORKER, state: 'working', settledAt: null } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop ranger-hello' }))
    expect(stopOrchestrationWorker).toHaveBeenCalledWith('ctx_1')
  })

  it('offers no Stop where this computer cannot stop it', () => {
    row({ running: true, canStop: false })
    expect(screen.queryByRole('button', { name: 'Stop ranger-hello' })).not.toBeInTheDocument()
  })
})
