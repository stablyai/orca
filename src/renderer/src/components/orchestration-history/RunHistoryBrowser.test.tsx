// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { publicRuntimeEnvironment } from '@/runtime/paired-runtime-environment-test-fixture'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RunEventsPage } from '../../../../shared/orchestration-run-events'
import { getDefaultSettings } from '../../../../shared/constants'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { RunHistoryBrowser } from './RunHistoryBrowser'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn<
    (
      target: RuntimeClientTarget,
      method: string,
      params?: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) => Promise<unknown>
  >(),
  open: vi.fn(async () => false)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationAddress: mocks.open }))

const initial = useAppStore.getInitialState()
const createdAt = '2026-10-28T10:00:00Z'
function list(objective: string) {
  return { runs: [{ id: 'run_shared', objective, created_at: createdAt }], nextCursor: null }
}
function events(title: string, sequence = 1, nextCursor: string | null = null): RunEventsPage {
  return {
    runId: 'run_shared',
    coverage: { completeFromCreation: false, recordedSince: createdAt },
    events: [
      {
        sequence,
        runId: 'run_shared',
        kind: 'task.created',
        entityId: `task_${sequence}`,
        taskId: `task_${sequence}`,
        dispatchId: null,
        recordedAt: createdAt,
        data: { title, status: 'ready' }
      }
    ],
    nextCursor
  }
}
function mount() {
  return render(
    <TooltipProvider>
      <RunHistoryBrowser onBack={() => {}} onClose={() => {}} onReveal={() => {}} />
    </TooltipProvider>
  )
}
beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.open.mockClear()
  useAppStore.setState({
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [
      publicRuntimeEnvironment({ id: 'a', name: 'Server A' }),
      publicRuntimeEnvironment({ id: 'b', name: 'Server B' })
    ],
    settings: { ...getDefaultSettings('test-home'), activeRuntimeEnvironmentId: 'a' }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

describe('run history browsing', () => {
  it('clears the selected Run when a server named local is replaced by this computer', async () => {
    useAppStore.setState({
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'local', name: 'Remote host' })],
      settings: { ...getDefaultSettings('test-home'), activeRuntimeEnvironmentId: 'local' }
    })
    mocks.rpc.mockImplementation(async (target, method) => {
      const owner = target.kind === 'local' ? 'this computer' : 'remote host'
      return method === 'orchestration.runList'
        ? list(`Run on ${owner}`)
        : events(`Work on ${owner}`)
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Run on remote host/ }))
    expect(await screen.findByText('Work on remote host')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Host' }))
    fireEvent.click(await screen.findByRole('option', { name: getLocalExecutionHostLabel() }))
    expect(await screen.findByRole('button', { name: /Run on this computer/ })).toBeInTheDocument()
    expect(screen.queryByText('Work on remote host')).not.toBeInTheDocument()
    expect(screen.queryByText('Work on this computer')).not.toBeInTheDocument()
  })
  it('isolates identical Run ids on different hosts and ignores late replies from the old host', async () => {
    const old = Promise.withResolvers<RunEventsPage>()
    mocks.rpc.mockImplementation(async (target, method) => {
      const host = target.kind === 'environment' ? target.environmentId : 'local'
      if (method === 'orchestration.runList') {
        return list(`Run on ${host}`)
      }
      return host === 'a' ? old.promise : events('Work on B')
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Run on a/ }))
    const oldSignal = mocks.rpc.mock.calls.find(
      ([target, method]) =>
        target.kind === 'environment' &&
        target.environmentId === 'a' &&
        method === 'orchestration.runEvents'
    )?.[3]?.signal
    fireEvent.click(screen.getByRole('combobox', { name: 'Host' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Server B' }))
    fireEvent.click(await screen.findByRole('button', { name: /Run on b/ }))
    expect(await screen.findByText('Work on B')).toBeInTheDocument()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => old.resolve(events('Work on A')))
    expect(screen.queryByText('Work on A')).not.toBeInTheDocument()
    act(() => useAppStore.setState({ runtimeEnvironments: [] }))
    expect(screen.getByText(/This host is no longer saved/)).toBeInTheDocument()
    expect(screen.queryByText('Work on B')).not.toBeInTheDocument()
    expect(mocks.rpc.mock.calls.every(([target]) => target.kind === 'environment')).toBe(true)
  })

  it('filters loaded events, retains them on failure, and appends the retried page', async () => {
    let moreAttempts = 0
    mocks.rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'orchestration.runList') {
        return list('Run on A')
      }
      if (params?.cursor) {
        if (++moreAttempts === 1) {
          throw new Error('offline')
        }
        return events('Beta task', 2)
      }
      return events('Alpha task', 1, 'next')
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Run on A/ }))
    expect(await screen.findByText('Alpha task')).toBeInTheDocument()
    expect(screen.getByText(/Earlier history is incomplete/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter loaded events' }), {
      target: { value: 'Beta' }
    })
    expect(await screen.findByText('No loaded events match this filter.')).toBeInTheDocument()
    expect(screen.getByText(/More events may match/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more events' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this page')
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter loaded events' }), {
      target: { value: '' }
    })
    expect(await screen.findByText('Alpha task')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Beta task')).toBeInTheDocument()
    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more events' })).not.toBeInTheDocument()
  })

  it('shows the host update remedy without claiming that an older host has no events', async () => {
    mocks.rpc.mockImplementation(async (_target, method) => {
      if (method === 'orchestration.runList') {
        return list('Old host run')
      }
      throw new RuntimeRpcCallError({
        id: 'req',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'old' }
      })
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Old host run/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Update Orca on the host')
    expect(screen.queryByText('No recorded events.')).not.toBeInTheDocument()
  })
})
