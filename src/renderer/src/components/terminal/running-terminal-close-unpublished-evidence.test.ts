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
// Why the real composer and not a literal: this whole file is about a payload with a
// FIELD MISSING, and a literal would keep the field missing after the producer grows one.
// `composeLegacyPtyProcessInspection` is what `DaemonPtyProcessInspection.inspectProcess`
// returns verbatim for a retained pre-v27 daemon, so this is that daemon's exact answer.
import {
  buildPtyProcessInspectionWireResult,
  composeLegacyPtyProcessInspection
} from '../../../../shared/pty-process-inspection-evidence'
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

function observedIdleShell() {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'zsh' },
    { verdict: 'exited' }
  )
}

/**
 * A host that predates the evidence contract: it publishes the legacy pair and no
 * `processEvidence` at all, and — unlike every other non-answer this guard already
 * handles — no `unavailable` either. Real producers: a retained daemon at protocol
 * 11..26 (`DaemonPtyProcessInspection.inspectProcess`), any provider with no
 * `inspectProcess` method (`inspectPtyProviderProcess`'s two-call fallback), and a
 * relay or runtime host older than the field, whose payload `SshPtyProvider` and
 * `inspectRuntimeTerminalProcess` pass through verbatim.
 */
describe('terminal-tab close on a host that published no evidence at all', () => {
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

  // The premise, stated through the producer: the shape carries neither of the two
  // fields this guard's other non-answer arms key on, so it arrives indistinguishable
  // from a host that positively observed an idle shell.
  it('publishes neither processEvidence nor unavailable', () => {
    const inspection = composeLegacyPtyProcessInspection('zsh')

    expect(inspection).not.toHaveProperty('processEvidence')
    expect(inspection).not.toHaveProperty('unavailable')
    expect(inspection.hasChildProcesses).toBe(observedIdleShell().hasChildProcesses)
  })

  it('asks when a tracked pane is answered by a host that could not state a verdict', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(composeLegacyPtyProcessInspection('zsh'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The second shape the same producer emits: a foreground read that landed on nothing.
  // `null` is how the legacy pair spells absence, and an unpublished host cannot say
  // whether it observed that absence or merely failed to look.
  it('asks when the unpublished answer names no foreground process at all', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(composeLegacyPtyProcessInspection(null))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The bare two-call provider route (`inspectPtyProviderProcess` with no
  // `inspectProcess` method) reaches here as the same field-less pair without going
  // through the composer, so it is pinned separately from the shape above.
  it('asks when a provider answered with the bare legacy pair', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The positive pole of the same degraded read still asks, and must keep asking: the
  // non-shell title is the one thing such a host can say that leans toward live work.
  it('asks when the unpublished answer names a non-shell foreground', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(composeLegacyPtyProcessInspection('codex'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // The positive still crosses the tracked narrowing, on this arm as on the `live` arm
  // above it: a leftover leaf whose host names a non-shell foreground is the one thing an
  // unpublished host can say without ambiguity, and it blocked the close before this change
  // too. Collapsing the positive along with the absences would silently drop that.
  it('asks for a layout-only leaf whose unpublished host names a non-shell foreground', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-stale' } }
      },
      agentStatusByPaneKey: {}
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a' ? observedIdleShell() : composeLegacyPtyProcessInspection('codex')
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  // SSH reconnect: a layout-only leaf the liveness map has dropped answers a non-answer
  // forever, and prompting on it would put a dialog in front of every reconnecting tab.
  // The narrowing #17076 added has to cover this arm too, or the fix breaks that case.
  it('still closes a layout-only leaf answered by an unpublished host', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-stale' } }
      },
      agentStatusByPaneKey: {}
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a' ? observedIdleShell() : composeLegacyPtyProcessInspection('zsh')
    )

    const onClose = await closeTab()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(2)
    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // `exited` stays the only verdict that closes with no prompt — the fix must separate
  // "the host stated it observed nothing" from "the host had no way to state anything".
  it('still closes silently when the host published a positive exited verdict', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(observedIdleShell())

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
