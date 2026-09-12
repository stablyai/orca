// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'

const { connectPanePty } = vi.hoisted(() => ({
  connectPanePty: vi.fn(() => ({ dispose: vi.fn() }))
}))

vi.mock('./pty-connection', () => ({ connectPanePty }))

import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'

function deferred(): {
  promise: Promise<void>
  reject: (error: Error) => void
  resolve: () => void
} {
  let reject!: (error: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, reject, resolve }
}

function renderRestartHarness(destroy: () => void | Promise<void>) {
  const pane = {
    id: 1,
    leafId: '11111111-1111-4111-8111-111111111111',
    container: document.createElement('div')
  }
  const manager = {
    getPanes: () => [pane],
    setActivePane: vi.fn()
  }
  let shutdownStarted = false
  const oldTransport = {
    getPtyId: () => (shutdownStarted ? null : 'pty-old'),
    getPendingShutdownPtyId: () => (shutdownStarted ? 'pty-old' : null),
    destroy: vi.fn(() => {
      shutdownStarted = true
      return destroy()
    })
  }
  const paneTransports = new Map<
    number,
    typeof oldTransport | { getPtyId: () => string; getPendingShutdownPtyId?: () => null }
  >([[pane.id, oldTransport]])
  const clearExitedPanePtyLayoutBinding = vi.fn()
  const clearExitedPanePtyLayoutBindingForLeaf = vi.fn()
  const clearCodexRestartNotice = vi.fn()
  const clearTabPtyId = vi.fn()
  const syncPanePtyLayoutBinding = vi.fn()

  const { rerender } = renderHook(() =>
    useTerminalPaneProcessExitActions({
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearExitedPanePtyLayoutBindingForLeaf,
      clearRuntimePaneTitle: vi.fn(),
      clearTabPtyId,
      clearTerminalPaneUnread: vi.fn(),
      clearTerminalTabUnread: vi.fn(),
      clearWorktreeUnread: vi.fn(),
      consumePendingCodexPaneRestart: vi.fn(() => true),
      cwd: 'C:\\repo',
      dispatchNotification: vi.fn(),
      executeClosePane: vi.fn(),
      handlePaneProcessDied: vi.fn(),
      isActiveRef: { current: true },
      isVisibleRef: { current: true },
      managerRef: { current: manager },
      markTerminalPaneUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markWorktreeUnread: vi.fn(),
      onAgentExitedRef: { current: null },
      onPtyErrorClearedRef: { current: null },
      onPtyErrorRef: { current: null },
      onPtyExitRef: { current: null },
      onPtyRecoveryStateRef: { current: null },
      paneKittyKeyboardModesRef: { current: new Map() },
      paneLastThemeModeRef: { current: new Map() },
      paneMode2031Ref: { current: new Map() },
      panePtyBindingsRef: { current: new Map() },
      paneTransportsRef: { current: paneTransports },
      pendingCodexPaneRestartIds: { 'pty-old': true },
      replayingPanesRef: { current: new Set() },
      savedLayout: { ptyIdsByLeafId: { [pane.leafId]: 'pty-old' } },
      setCacheTimerStartedAt: vi.fn(),
      setPaneProcessExitsByPaneId: vi.fn(),
      setRuntimePaneTitle: vi.fn(),
      setTerminalError: vi.fn(),
      setTerminalErrorsByPaneId: vi.fn(),
      showRestoredSessionBanner: vi.fn(),
      suppressPtyExit: vi.fn(),
      syncPanePtyLayoutBinding,
      tabId: 'tab-1',
      updateTabPtyId: vi.fn(),
      updateTabTitle: vi.fn(),
      worktreeId: 'worktree-1'
    } as never)
  )

  return {
    clearCodexRestartNotice,
    clearExitedPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBindingForLeaf,
    clearTabPtyId,
    oldTransport,
    pane,
    paneTransports,
    rerender,
    syncPanePtyLayoutBinding
  }
}

describe('mounted Codex account restart ordering', () => {
  beforeEach(() => {
    connectPanePty.mockClear()
  })

  it('waits for the outdated PTY to stop before launching its replacement', async () => {
    const stopped = deferred()
    const harness = renderRestartHarness(() => stopped.promise)

    await waitFor(() => expect(harness.oldTransport.destroy).toHaveBeenCalledOnce())
    expect(connectPanePty).not.toHaveBeenCalled()
    harness.rerender()
    await Promise.resolve()
    expect(harness.oldTransport.destroy).toHaveBeenCalledOnce()

    stopped.resolve()
    await waitFor(() => expect(connectPanePty).toHaveBeenCalledOnce())
    expect(harness.clearExitedPanePtyLayoutBindingForLeaf).toHaveBeenCalledWith(
      harness.pane.leafId,
      'pty-old'
    )
    expect(harness.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(harness.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
  })

  it('does not clear or replace a newer transport that wins during shutdown', async () => {
    const stopped = deferred()
    const harness = renderRestartHarness(() => stopped.promise)
    await waitFor(() => expect(harness.oldTransport.destroy).toHaveBeenCalledOnce())
    const replacementTransport = { getPtyId: () => 'pty-new' }
    harness.paneTransports.set(harness.pane.id, replacementTransport)

    stopped.resolve()

    await waitFor(() =>
      expect(harness.clearExitedPanePtyLayoutBindingForLeaf).toHaveBeenCalledWith(
        harness.pane.leafId,
        'pty-old'
      )
    )
    expect(harness.paneTransports.get(harness.pane.id)).toBe(replacementTransport)
    expect(harness.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(connectPanePty).not.toHaveBeenCalled()
  })

  it('reopens the prompt when the outdated PTY cannot be stopped', async () => {
    const stopped = deferred()
    let shutdownAttempts = 0
    const reopenCodexRestartPrompt = vi
      .spyOn(useAppStore.getState(), 'reopenCodexRestartPrompt')
      .mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = renderRestartHarness(() => {
      shutdownAttempts += 1
      return shutdownAttempts === 1 ? stopped.promise : Promise.resolve()
    })
    await waitFor(() => expect(harness.oldTransport.destroy).toHaveBeenCalledOnce())

    stopped.reject(new Error('shutdown failed'))

    await waitFor(() => expect(reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-old'))
    expect(harness.clearCodexRestartNotice).not.toHaveBeenCalled()
    expect(harness.clearTabPtyId).not.toHaveBeenCalled()
    expect(harness.clearExitedPanePtyLayoutBindingForLeaf).not.toHaveBeenCalled()
    expect(connectPanePty).not.toHaveBeenCalled()

    harness.rerender()
    await waitFor(() => expect(harness.oldTransport.destroy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(connectPanePty).toHaveBeenCalledOnce())
    warn.mockRestore()
    reopenCodexRestartPrompt.mockRestore()
  })
})
