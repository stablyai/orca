import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
// Why the real collapse and not a hand-written literal: the claim under test is that
// `hasChildProcesses` is `children.verdict === 'live'` flattened, so an `unverifiable`
// verdict reaches this guard byte-identical to an observed-idle shell. A literal would
// keep asserting that after the collapse drifts, and would omit whatever field it grew.
// That the local and daemon producers really emit this shape — verdict `unverifiable`,
// boolean `false`, `unavailable` absent — is pinned on the main side, where those modules
// live: src/main/providers/pty-inspection-unverifiable-without-unavailable.test.ts.
import { buildPtyProcessInspectionWireResult } from '../../../../shared/pty-process-inspection-evidence'
import { guardRunningTerminalClose } from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** A host that was reached and could not tell: the degraded local process-table scan, the
 *  failed node-pty title read, and the daemon pane whose only child signal is a foreground
 *  observation that did not land all publish this. */
function degradedInContact(reason: string) {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'unverifiable', reason },
    { verdict: 'unverifiable', reason }
  )
}

/** The daemon shape that would give a legacy `hasChildProcesses` vote something to say: a
 *  pane whose subprocess handle has no evidence channel publishes the boolean from the raw
 *  foreground title while the children verdict stays `unverifiable`. Pinned on the main side,
 *  where that producer lives — src/main/daemon/terminal-host-inspection-degraded-handle.test.ts
 *  ('does not upgrade a named agent to observed either'). */
function degradedWithNonShellTitle(name: string) {
  const reason = 'subprocess handle reports no foreground evidence'
  return {
    foregroundProcess: name,
    hasChildProcesses: true,
    processEvidence: {
      foreground: { verdict: 'unverifiable' as const, reason },
      children: { verdict: 'unverifiable' as const, reason }
    }
  }
}

function observedIdleShell() {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'zsh' },
    { verdict: 'exited' }
  )
}

describe('terminal-tab close on an in-contact probe that could not tell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
      agentStatusByPaneKey: {}
    })
  })

  async function closeTab(): Promise<ReturnType<typeof vi.fn>> {
    const onClose = vi.fn()
    guardRunningTerminalClose({ terminalTabId: 'tab-1', tabLabel: 'npm run dev', onClose })
    await settleProbe()
    return onClose
  }

  // The shape is what makes this a coercion and not a routing bug: nothing on the wire
  // distinguishes it from an idle shell except the verdict, and this close kills the pty.
  it('publishes an unverifiable verdict as an idle-looking boolean with no unavailable flag', () => {
    const inspection = degradedInContact('process table scan degraded')

    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection.processEvidence.children.verdict).toBe('unverifiable')
    expect(inspection).not.toHaveProperty('unavailable')
    expect(inspection.hasChildProcesses).toBe(observedIdleShell().hasChildProcesses)
  })

  it('asks when a degraded scan leaves the children verdict unverifiable', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(
      degradedInContact('process table scan degraded')
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks when the local pty title read itself failed', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(degradedInContact('pty title read failed'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The other half of the collapse: the local classifier publishes `false` beside a
  // positively observed 'live' when a stale shell title would otherwise contradict the
  // completed scan. The boolean alone read that as idle and killed a running agent.
  it('asks when the boolean says false but the scan observed live children', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      ...buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'claude' },
        { verdict: 'live' }
      ),
      hasChildProcesses: false
    })

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The shape that makes the legacy boolean unusable here, from the one producer that really
  // emits it. Both cases below read the same probe; only the id set differs, so together they
  // pin that the verdict decides and the boolean never gets a vote of its own.
  it('asks when a tracked pane degrades to a title it cannot vouch for', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(degradedWithNonShellTitle('codex'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes a layout-only leaf on the degraded read the legacy boolean calls busy', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-stale' } }
      },
      agentStatusByPaneKey: {}
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a' ? observedIdleShell() : degradedWithNonShellTitle('codex')
    )

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The narrowing #17076 added, on this arm too: an id the liveness map has dropped is a
  // leftover leaf, and prompting on it would block every reconnecting ssh tab.
  it('closes when only a layout-only pty is unverifiable and the tracked pane exited', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-stale' } }
      },
      agentStatusByPaneKey: {}
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a' ? observedIdleShell() : degradedInContact('process table scan degraded')
    )

    const onClose = await closeTab()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(2)
    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The completed scan that positively observed an idle shell keeps closing silently — the
  // fix must separate "observed nothing running" from "could not tell", not merge them.
  it('still closes silently when the scan completed and observed an idle shell', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(observedIdleShell())

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
