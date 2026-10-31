import type * as IpcPtyTransportModule from './pty-transport'
import { expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { LEAF_1, createPane, createManager } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { PaneConnectionDeps } from './pty-connection-test-deps'

export function registerUnqualifiedSavedInputTest(context: {
  getState: () => StoreState
  createDeps: (overrides?: Record<string, unknown>) => PaneConnectionDeps
  useIpcTransport: (factory: typeof IpcPtyTransportModule.createIpcPtyTransport) => void
}): void {
  it('dispatches immediately without inference when a restarted authority-off foreign saved PTY has no receipt', async () => {
    context.useIpcTransport(
      (await vi.importActual<typeof IpcPtyTransportModule>('./pty-transport')).createIpcPtyTransport
    )
    const mockStoreState = context.getState()
    const { connectPanePty } = await import('./pty-connection')
    const handler = await import('./terminal-side-effect-facts-handler')
    const savedId = 'other-repo::other-worktree@@surviving-shell'
    mockStoreState.tabsByWorktree['wt-1'] = [
      { id: 'tab-1', ptyId: savedId, title: 'Codex working', defaultTitle: 'Terminal' }
    ]
    mockStoreState.ptyIdsByTabId['tab-1'] = [savedId]
    mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = { [LEAF_1]: savedId }
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Codex working' } }
    const present = createDeferred<boolean>()
    const accepted = createDeferred<boolean>()
    Object.assign(window.api.pty, {
      hasPty: vi.fn(() => present.promise),
      spawn: vi.fn(),
      resize: vi.fn(),
      writeAccepted: vi.fn(() => accepted.promise)
    })
    const pane = createPane(1)
    const signals = new Set<() => void>()
    Object.assign(pane.terminal, {
      _core: {
        coreService: {
          onUserInput: (listener: () => void) => {
            signals.add(listener)
            return {
              dispose: () => {
                signals.delete(listener)
              }
            }
          }
        }
      }
    })
    const deps = context.createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: savedId }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mock xterm/manager and partial saved-PTY refs supply this real IPC path; held hasPty/write ACK prove immediate input without inventing a resident or process receipt.
    const connection = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(40)
    expect(window.api.pty.hasPty).toHaveBeenCalledWith(savedId)
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(handler.getTerminalSemanticResident(savedId)).toBeUndefined()
    expect(signals.size).toBeGreaterThan(0)
    expect(() => {
      signals.forEach((signal) => signal())
      sendTerminalInputThroughPane(pane, '\x03')
    }).not.toThrow()
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith(savedId, '\x03', 'driving')
    accepted.resolve(true)
    await flushAsyncTicks()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(handler.getTerminalSemanticResident(savedId)).toBeUndefined()
    present.resolve(true)
    await flushAsyncTicks(40)
    expect(handler.getTerminalSemanticResident(savedId)).toBeDefined()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    connection.dispose()
  })
}
