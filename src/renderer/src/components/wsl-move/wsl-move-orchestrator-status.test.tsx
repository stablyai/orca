// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'

const toasts = vi.hoisted(() => ({ calls: new Array<string>() }))
vi.mock('sonner', () => {
  const toast = (message: string) => toasts.calls.push(message)
  toast.success = (message: string) => toasts.calls.push(message)
  return { toast }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({ tabsByWorktree: {} }) })
}))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: vi.fn() }))

const { followWslMoveOrchestratorStatus, useWslMoveOrchestratorStatus } =
  await import('./wsl-move-orchestrator-status')
const { WslMoveOrchestratorStatusLine } = await import('./WslMoveOrchestratorStatusLine')

function record(state: WslMoveOrchestratorRecord['state']): WslMoveOrchestratorRecord {
  return { distro: 'Ubuntu', state, attempts: 0, appVersion: '1.0.0', updatedAt: 0 }
}

type Listener = (records: WslMoveOrchestratorRecord[]) => void
let listeners: Listener[]
let listOrchestrator: ReturnType<typeof vi.fn>
let onOrchestratorStatus: ReturnType<typeof vi.fn>

function installApi(initial: WslMoveOrchestratorRecord[]): void {
  listeners = []
  listOrchestrator = vi.fn(async () => initial)
  onOrchestratorStatus = vi.fn((listener: Listener) => {
    listeners.push(listener)
    return () => {}
  })
  vi.stubGlobal('api', {
    wslMove: { listOrchestrator, onOrchestratorStatus, orchestratorUserAction: vi.fn() }
  })
}

function renderLine(): string {
  const { container } = render(<WslMoveOrchestratorStatusLine distro="ubuntu" />)
  const html = container.innerHTML
  cleanup()
  return html
}

beforeEach(() => {
  toasts.calls.length = 0
  useWslMoveOrchestratorStatus.setState({ records: {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('following the move orchestrator (D3a-2)', () => {
  it('announces nothing for a parked state already there on load', async () => {
    installApi([record({ kind: 'parked', reason: 'stuck' })])
    const stop = followWslMoveOrchestratorStatus()
    await vi.waitFor(() => expect(listOrchestrator).toHaveBeenCalled())
    await Promise.resolve()
    expect(renderLine()).toContain("hasn't finished settling")
    expect(toasts.calls).toEqual([])
    stop()
  })

  it('toasts a live change to parked and to done, once each', async () => {
    installApi([record({ kind: 'pending' })])
    const stop = followWslMoveOrchestratorStatus()
    await vi.waitFor(() => expect(listOrchestrator).toHaveBeenCalled())
    await Promise.resolve()
    for (const listener of listeners) {
      listener([record({ kind: 'parked', reason: 'stuck' })])
      listener([record({ kind: 'parked', reason: 'stuck' })])
      listener([record({ kind: 'done', migrationId: 'm1' })])
    }
    expect(toasts.calls).toEqual([
      "An earlier move to the Ubuntu host hasn't finished settling.",
      'Projects moved to the Ubuntu host'
    ])
    stop()
  })

  it('clears what it read when it stops, so a switched-off window shows nothing', async () => {
    installApi([record({ kind: 'parked', reason: 'stuck' })])
    const stop = followWslMoveOrchestratorStatus()
    await vi.waitFor(() => expect(listOrchestrator).toHaveBeenCalled())
    await Promise.resolve()
    stop()
    expect(renderLine()).toBe('')
  })
})
