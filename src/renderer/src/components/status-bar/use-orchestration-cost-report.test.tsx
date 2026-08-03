// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    (error as { code?: string } | null)?.code === code
}))

import { useOrchestrationCostReport } from './use-orchestration-cost-report'

const target = { kind: 'local' as const }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function report(id: string): OrchestrationCostReport {
  return {
    run: { id, createdAt: '', updatedAt: '' },
    generatedAt: '',
    schemaVersion: 1
  } as OrchestrationCostReport
}

function Harness({ runId, open = false }: { runId: string | null; open?: boolean }) {
  const state = useOrchestrationCostReport(target, runId, open)
  return (
    <div
      data-testid="state"
      data-run={state.report?.run.id ?? ''}
      data-error={state.error ?? ''}
      data-stale={String(state.stale)}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useOrchestrationCostReport', () => {
  it('ignores a stale response after the selected run changes', async () => {
    const first = deferred<OrchestrationCostReport>()
    const second = deferred<OrchestrationCostReport>()
    mocks.callRuntimeRpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<Harness runId="run-a" />)
    view.rerender(<Harness runId="run-b" />)
    await act(async () => second.resolve(report('run-b')))
    expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-b')
    await act(async () => first.resolve(report('run-a')))
    expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-b')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      target,
      'orchestration.report',
      { id: 'run-b' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('keeps the last report as explicitly stale after a transient refresh failure', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce(report('run-a'))
    const view = render(<Harness runId="run-a" />)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-a'))
    mocks.callRuntimeRpc.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { code: 'runtime' })
    )
    view.rerender(<Harness runId="run-a" open />)
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveAttribute('data-error', 'runtime')
    )
    expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-a')
    expect(screen.getByTestId('state')).toHaveAttribute('data-stale', 'true')
  })

  it('preserves stale disclosure while an open-state refresh is deferred', async () => {
    const refresh = deferred<OrchestrationCostReport>()
    mocks.callRuntimeRpc
      .mockResolvedValueOnce(report('run-a'))
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'runtime' }))
      .mockReturnValueOnce(refresh.promise)
    const view = render(<Harness runId="run-a" />)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-a'))
    view.rerender(<Harness runId="run-a" open />)
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveAttribute('data-error', 'runtime')
    )

    view.rerender(<Harness runId="run-a" />)
    expect(screen.getByTestId('state')).toHaveAttribute('data-error', 'runtime')
    expect(screen.getByTestId('state')).toHaveAttribute('data-stale', 'true')
    expect(screen.getByTestId('state')).toHaveAttribute('data-run', 'run-a')

    await act(async () => refresh.resolve(report('run-a')))
    expect(screen.getByTestId('state')).toHaveAttribute('data-error', '')
    expect(screen.getByTestId('state')).toHaveAttribute('data-stale', 'false')
  })

  it('classifies older runtimes and removed runs without retaining mismatched data', async () => {
    mocks.callRuntimeRpc
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'method_not_found' }))
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'run_not_found' }))
    const view = render(<Harness runId="run-old" />)
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveAttribute('data-error', 'older-runtime')
    )
    view.rerender(<Harness runId="run-gone" />)
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveAttribute('data-error', 'run-not-found')
    )
    expect(screen.getByTestId('state')).toHaveAttribute('data-run', '')
  })
})
