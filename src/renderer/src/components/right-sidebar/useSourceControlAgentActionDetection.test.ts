// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SourceControlAgentDetectionTargetModule from '@/lib/source-control-agent-detection-target'
import type { TuiAgent } from '../../../../shared/tui-agent'

const { ensureSourceControlDetectedAgents } = vi.hoisted(() => ({
  ensureSourceControlDetectedAgents: vi.fn()
}))

vi.mock('@/lib/source-control-agent-detection-target', async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlAgentDetectionTargetModule>()
  return { ...actual, ensureSourceControlDetectedAgents }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign((selector: (state: object) => unknown) => selector({}), {
    getState: () => ({})
  })
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

import { useSourceControlAgentActionDetection } from './useSourceControlAgentActionDetection'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useSourceControlAgentActionDetection', () => {
  beforeEach(() => {
    ensureSourceControlDetectedAgents.mockReset()
  })

  it('ignores a stale probe after the detection target changes', async () => {
    const first = deferred<TuiAgent[]>()
    const second = deferred<TuiAgent[]>()
    ensureSourceControlDetectedAgents
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { result, rerender } = renderHook(
      (props: { connectionId: string | null }) =>
        useSourceControlAgentActionDetection({
          worktreeId: 'wt-1',
          connectionId: props.connectionId
        }),
      { initialProps: { connectionId: null as string | null } }
    )

    let firstRefresh!: Promise<TuiAgent[]>
    await act(async () => {
      firstRefresh = result.current.refreshDetectedAgents()
    })
    expect(result.current.detecting).toBe(true)

    await act(async () => {
      rerender({ connectionId: 'ssh-1' })
    })

    let secondRefresh!: Promise<TuiAgent[]>
    await act(async () => {
      secondRefresh = result.current.refreshDetectedAgents()
    })

    await act(async () => {
      first.resolve(['claude'])
      await firstRefresh
    })
    expect(result.current.detectedAgents).toEqual([])
    expect(result.current.detecting).toBe(true)

    await act(async () => {
      second.resolve(['codex'])
      await secondRefresh
    })
    expect(result.current.detectedAgents).toEqual(['codex'])
    expect(result.current.detecting).toBe(false)
  })

  it('ignores a probe that finishes after the target changes and before the next refresh', async () => {
    const first = deferred<TuiAgent[]>()
    ensureSourceControlDetectedAgents.mockReturnValueOnce(first.promise)

    const { result, rerender } = renderHook(
      (props: { connectionId: string | null }) =>
        useSourceControlAgentActionDetection({
          worktreeId: 'wt-1',
          connectionId: props.connectionId
        }),
      { initialProps: { connectionId: null as string | null } }
    )

    let firstRefresh!: Promise<TuiAgent[]>
    await act(async () => {
      firstRefresh = result.current.refreshDetectedAgents()
    })

    await act(async () => {
      rerender({ connectionId: 'ssh-1' })
    })

    await act(async () => {
      first.resolve(['claude'])
      await firstRefresh
    })

    expect(result.current.detectedAgents).toEqual([])
    expect(result.current.detecting).toBe(false)
    expect(ensureSourceControlDetectedAgents).toHaveBeenCalledOnce()
  })
})
