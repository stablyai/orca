// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaestroRunProgress } from '../../../../shared/maestro-run-progress'

const getMaestroProjection = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-maestro-client', () => ({ getMaestroProjection }))

import { useMaestroWorkspaceRunProgress } from './useMaestroWorkspaceRunProgress'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const target = { kind: 'local' as const }
let root: Root
let container: HTMLDivElement
let current: MaestroRunProgress | null = null

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function Probe({ workspaceKey }: { workspaceKey: string }): React.JSX.Element {
  current = useMaestroWorkspaceRunProgress(target, {
    execution_host_id: 'local',
    workspace_key: workspaceKey
  })
  return createElement('span', null, current?.available ? 'available' : 'empty')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  getMaestroProjection.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useMaestroWorkspaceRunProgress', () => {
  it('projects progress from the exact workspace projection without an index entry', async () => {
    getMaestroProjection.mockResolvedValueOnce({
      runProgress: { available: false, state: 'outcome_unknown' }
    })

    await act(async () => root.render(createElement(Probe, { workspaceKey: 'folder:exact' })))

    expect(getMaestroProjection).toHaveBeenCalledWith(target, {
      execution_host_id: 'local',
      workspace_key: 'folder:exact'
    })
    expect(current).toEqual({ available: false, state: 'outcome_unknown' })
  })

  it('never projects an old workspace response into a new scope', async () => {
    const oldResponse = deferred<{ runProgress: MaestroRunProgress }>()
    const newResponse = deferred<{ runProgress: MaestroRunProgress }>()
    getMaestroProjection
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise)
    await act(async () => root.render(createElement(Probe, { workspaceKey: 'folder:old' })))
    await act(async () => root.render(createElement(Probe, { workspaceKey: 'folder:new' })))
    oldResponse.resolve({
      runProgress: { available: false, state: 'outcome_unknown' }
    })
    await act(async () => oldResponse.promise)
    expect(current).toBeNull()

    newResponse.resolve({
      runProgress: { available: false, state: 'outcome_unknown' }
    })
    await act(async () => newResponse.promise)
    expect(current).toEqual({ available: false, state: 'outcome_unknown' })
  })

  it('retains the last confirmed projection through a transient poll failure', async () => {
    vi.useFakeTimers()
    getMaestroProjection
      .mockResolvedValueOnce({
        runId: 'run-1',
        revision: 1,
        runProgress: { available: false, state: 'outcome_unknown' }
      })
      .mockRejectedValueOnce(new Error('temporary transport failure'))

    await act(async () => root.render(createElement(Probe, { workspaceKey: 'folder:stable' })))
    expect(current).toEqual({ available: false, state: 'outcome_unknown' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(current).toEqual({ available: false, state: 'outcome_unknown' })
  })
})
