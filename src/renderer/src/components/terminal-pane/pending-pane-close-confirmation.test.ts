import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from './pending-split-close-test-fixture'
import { preparePendingRuntimeClose } from './pending-runtime-pane-close-test-fixture'
import { flushPtySideEffects } from './pty-transport-test-harness'
import type { PtyRunningWorkProbe } from '../terminal/pty-running-work-probe'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

async function prepare(remote = false, requestedPtyId?: string) {
  const paired = remote ? await preparePendingRuntimeClose() : undefined
  const p = paired ?? (await preparePendingSplitClose(requestedPtyId))
  Object.assign(p.state, { settings: { skipCloseTerminalWithRunningProcessConfirm: false } })
  const { probePtyRunningWork } = await import('../terminal/pty-running-work-probe')
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
  const closed = () =>
    paired
      ? paired.runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.close')
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

it.each([false, true])('requires confirmation for pending live work, paired=%s', async (remote) => {
  const p = await prepare(remote)
  p.actions.handleRequestClosePane(1)
  expect(p.probePtyRunningWork).toHaveBeenCalledWith(
    expect.any(Object),
    [remote ? 'remote:env-1@@term_original' : 'pty-restored'],
    expect.any(Object)
  )
  expect(p.closed()).toBe(false)
  p.verdict('live')
  await flushPtySideEffects()
  expect(p.controller.setPendingCloseConfirmation).toHaveBeenCalledWith(
    expect.objectContaining({ paneId: 1 })
  )
  expect(p.closed()).toBe(false)
  p.actions.handleConfirmClose(false)
  await p.settle()
  expect(p.closed()).toBe(true)
})

it.each([false, true])('Cancel preserves pending work, paired=%s', async (remote) => {
  const p = await prepare(remote)
  p.actions.handleRequestClosePane(1)
  p.verdict('live')
  await flushPtySideEffects()
  p.actions.handleCancelClose()
  p.actions.handleConfirmClose(false)
  await p.settle()
  expect(p.closed()).toBe(false)
})

it.each(['unverifiable', 'rejected', 'timeout'] as const)(
  'requires confirmation when a pending owner probe is %s',
  async (mode) => {
    vi.useFakeTimers()
    const p = await prepare()
    p.actions.handleRequestClosePane(1)
    if (mode === 'rejected') {
      p.reply.reject(new Error('owner unavailable'))
    } else if (mode === 'unverifiable') {
      p.verdict(mode)
    } else {
      await vi.advanceTimersByTimeAsync(101)
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(p.controller.setPendingCloseConfirmation).toHaveBeenCalled()
    expect(p.closed()).toBe(false)
    p.actions.handleCancelClose()
    p.verdict('exited')
    vi.useRealTimers()
    await p.settle()
    expect(p.closed()).toBe(false)
  }
)

it('uses the direct SSH identity in the running-work probe', async () => {
  const id = 'ssh:ssh-1@@pty-restored'
  const p = await prepare(false, id)
  p.state.worktreesByRepo = { repo: [{ id: 'workspace', repoId: 'repo', hostId: 'ssh:ssh-1' }] }
  p.actions.handleRequestClosePane(1)
  p.verdict('live')
  await flushPtySideEffects()
  expect(p.probePtyRunningWork).toHaveBeenCalledWith(expect.any(Object), [id], expect.any(Object))
  expect(p.closed()).toBe(false)
  p.actions.handleConfirmClose(false)
  await p.settle()
  expect(window.api.pty.kill).toHaveBeenCalledWith(id)
})

it.each(['rejected', 'timeout'] as const)(
  'honors the skip-confirmation setting when a pending probe is %s',
  async (mode) => {
    vi.useFakeTimers()
    const p = await prepare()
    Object.assign(p.state, { settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
    p.actions.handleRequestClosePane(1)
    if (mode === 'rejected') {
      p.reply.reject(new Error('owner unavailable'))
    } else {
      await vi.advanceTimersByTimeAsync(101)
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(p.controller.setPendingCloseConfirmation).not.toHaveBeenCalled()
    expect(p.closed()).toBe(true)
    p.verdict('exited')
    vi.useRealTimers()
    await p.settle()
  }
)

it.each(['exited', 'skip-setting'] as const)('keeps allowed pending close for %s', async (mode) => {
  const p = await prepare()
  if (mode === 'skip-setting') {
    Object.assign(p.state, { settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
  }
  p.actions.handleRequestClosePane(1)
  p.verdict(mode === 'exited' ? 'exited' : 'live')
  await flushPtySideEffects()
  expect(p.controller.setPendingCloseConfirmation).not.toHaveBeenCalled()
  await p.settle()
  expect(p.closed()).toBe(true)
})

it.each(['probe', 'dialog'] as const)(
  'accepts the same pending attach finishing during %s',
  async (phase) => {
    const p = await prepare()
    p.actions.handleRequestClosePane(1)
    if (phase === 'dialog') {
      p.verdict('live')
      await flushPtySideEffects()
    }
    p.spawn.resolve({ id: 'pty-restored', isReattach: true })
    await p.connecting
    p.verdict('live')
    await flushPtySideEffects()
    expect(p.closed()).toBe(false)
    p.actions.handleConfirmClose(false)
    await flushPtySideEffects()
    expect(p.closed()).toBe(true)
  }
)

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
