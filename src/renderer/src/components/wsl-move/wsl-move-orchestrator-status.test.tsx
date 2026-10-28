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
const { WslMoveOrchestratorStatusLine, showBlockingTerminal } =
  await import('./WslMoveOrchestratorStatusLine')
const { wslMoveOrchestratorLine } = await import('./wsl-move-orchestrator-copy')

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

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

describe('the status line, by state', () => {
  const show = (state: WslMoveOrchestratorRecord['state']): string => {
    useWslMoveOrchestratorStatus.setState({
      records: { ['ubuntu']: record(state) }
    })
    return renderLine()
  }

  it('says what is still busy for a deferred move, with Show terminal and Check again', () => {
    const html = show({
      kind: 'deferred',
      blockers: [{ kind: 'agent-working', ids: [PANE], actions: ['wait', 'end'] }],
      rechecks: 0
    })
    expect(html).toContain('Finishing your move to the Ubuntu host')
    expect(html).toContain('Show terminal')
    expect(html).toContain('Check again')
  })

  it('never calls a stuck move failed', () => {
    const html = show({ kind: 'parked', reason: 'stuck' })
    expect(html).toContain("An earlier move to the Ubuntu host hasn't finished settling.")
    expect(html.toLowerCase()).not.toContain('fail')
    expect(html).toContain('Check again')
  })

  it('offers only Move again for a distro the user brought back, never Not now', () => {
    const html = show({ kind: 'parked', reason: 'declined', cause: 'released-here' })
    expect(html).toContain('brought these projects back to this computer')
    expect(html).toContain('Move again')
    expect(html).not.toContain('Not now')
  })

  it('shows nothing for a removed host or a pending Remove', () => {
    expect(show({ kind: 'parked', reason: 'declined', cause: 'removed' })).toBe('')
    expect(show({ kind: 'parked', reason: 'removal-pending' })).toBe('')
    expect(wslMoveOrchestratorLine(undefined)).toBeNull()
  })

  // Pre-review #2: what waits for the user gets a calm line and Check again, never "failed".
  it('shows a neutral paused line with Check again for each reason that waits for the user', () => {
    for (const [reason, words] of [
      ['export-incomplete', "can't be carried over yet"],
      ['manifest-too-large', 'more saved state than one move can carry'],
      ['host-update-required', 'the host needs an update first'],
      ['attempts-exhausted', "didn't complete after several tries"]
    ] as const) {
      const html = show({ kind: 'parked', reason })
      expect(html).toContain('Moving projects to the Ubuntu host is paused: ')
      expect(html).toContain(words)
      expect(html).toContain('Check again')
      expect(html.toLowerCase()).not.toContain('fail')
    }
  })

  it('says each blocker in one sentence', () => {
    const html = show({
      kind: 'deferred',
      blockers: [{ kind: 'automation-running', ids: ['run-1'], actions: ['wait'] }],
      rechecks: 0
    })
    expect(html).toContain('Wait for it to finish, then check again.')
    expect(html).not.toContain('Show terminal')
  })
})

describe('Show terminal', () => {
  // Pre-review #5: a pane that is gone gets a word back, not silence.
  it('says so when the terminal is no longer open', () => {
    showBlockingTerminal(PANE)
    expect(toasts.calls).toEqual([
      "That terminal isn't open in this window any more. Check again to refresh."
    ])
  })
})
