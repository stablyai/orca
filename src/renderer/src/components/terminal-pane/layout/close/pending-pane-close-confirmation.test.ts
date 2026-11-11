import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from './pending-split-close-test-fixture'
import { preparePendingRuntimeClose } from './pending-runtime-pane-close-test-fixture'
import { flushPtySideEffects } from '../../pty-transport/ipc/pty-transport-test-harness'
import type { PtyRunningWorkProbe } from '../../../../../../shared/terminal/pty/lifecycle/pty-running-work-probe'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

async function prepare(remote = false, requestedPtyId?: string) {
  const paired = remote ? await preparePendingRuntimeClose() : undefined
  const p = paired ?? (await preparePendingSplitClose(requestedPtyId))
  Object.assign(p.state, { settings: { skipCloseTerminalWithRunningProcessConfirm: false } })
  const { probePtyRunningWork } = await import('../../../terminal/pty-running-work-probe')
  const { useTerminalPaneCloseActions } = await import('./use-terminal-pane-close-actions')
  // Supply the dialog state that the UI renders after setPendingCloseConfirmation.
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- React registration is mocked; exercise public close callbacks without mounting UI.
  const actions = useTerminalPaneCloseActions({
    ...p.controller,
    pendingCloseConfirmation: { paneId: 1, copyKind: 'command' }
  })
  const reply = Promise.withResolvers<PtyRunningWorkProbe[]>()
  vi.mocked(probePtyRunningWork).mockReturnValueOnce(reply.promise)
  const verdict = (value: PtyRunningWorkProbe['verdict']) =>
    reply.resolve([{ ptyId: 'captured', verdict: value, timedOut: false, remote }])
  // A layout-owner build asks main to close the pane (main stops its terminal); else it is killed here.
  const closed = () =>
    paired
      ? paired.runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.close')
      : ORCA_LAYOUT_OWNER_IS_MAIN
        ? 'sentPaneCloses' in p && p.sentPaneCloses().length > 0
        : vi.mocked(window.api.pty.kill).mock.calls.length > 0
  const settle = async () => {
    if (paired) {
      paired.acceptCompatibility()
      await paired.settle()
    } else {
      p.spawn.resolve({ id: requestedPtyId ?? 'pty-restored', isReattach: true })
      await p.connecting
    }
    await flushPtySideEffects()
  }
  return { ...p, paired, actions, probePtyRunningWork, verdict, reply, closed, settle }
}

it.each(['tab', 'generation', 'leaf', 'transport', 'manager', 'whole-tab', 'binding'] as const)(
  'does not apply a pending confirmation to a replacement %s',
  async (replacement) => {
    const p = await prepare()
    p.actions.handleRequestClosePane(1)
    p.verdict('live')
    await flushPtySideEffects()
    if (replacement === 'tab') {
      p.state.tabsByWorktree.workspace[0].createdAt += 1
    }
    if (replacement === 'generation') {
      p.state.tabsByWorktree.workspace[0].generation = 1
    }
    if (replacement === 'leaf') {
      p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = {}
    }
    if (replacement === 'binding') {
      p.state.terminalLayoutsByTabId[p.tabId].ptyIdsByLeafId = { [p.leafId]: 'successor' }
    }
    if (replacement === 'transport') {
      p.transports.delete(1)
    }
    if (replacement === 'manager') {
      p.controller.managerRef.current = null
    }
    if (replacement === 'whole-tab') {
      vi.spyOn(p.controller.managerRef.current!, 'getPanes').mockReturnValue([])
    }
    p.actions.handleConfirmClose(false)
    await p.settle()
    expect(p.closed()).toBe(false)
    expect(p.controller.onCloseTab).not.toHaveBeenCalled()
    p.transport.detach?.({ preserveExitObserver: false })
  }
)

it.each(['probe', 'dialog'] as const)(
  'does not close a re-paired host after %s starts',
  async (phase) => {
    const p = await prepare(true)
    if (!p.paired) {
      throw new Error('paired fixture required')
    }
    p.actions.handleRequestClosePane(1)
    if (phase === 'dialog') {
      p.verdict('live')
      await flushPtySideEffects()
    }
    p.paired.replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 2, pairingRevision: 2 }])
    p.verdict('live')
    await flushPtySideEffects()
    if (phase === 'dialog') {
      p.actions.handleConfirmClose(false)
    }
    await p.settle()
    expect(p.closed()).toBe(false)
  }
)
