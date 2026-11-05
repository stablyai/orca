import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useTerminalPaneController } from '../../src/renderer/src/components/terminal-pane/use-terminal-pane-controller'
import { LinkRoutingPreferenceDialogContext } from '../../src/renderer/src/components/link-routing-preference-dialog-context'
import { createSessionWriteSubscriber } from '../../src/renderer/src/lib/session-write-subscriber'
import { patchWorkspaceSessionByHost } from '../../src/renderer/src/lib/workspace-session-host-persistence'
import { setRuntimeGraphSyncEnabled } from '../../src/renderer/src/runtime/sync-runtime-graph'
import type { setupRetirementRuntime } from './terminal-retirement-runtime.test-fixture'

export async function mountReservedTerminal(
  fixture: Awaited<ReturnType<typeof setupRetirementRuntime>>
) {
  const { renderer, pane, seed } = fixture
  const worktreeId = seed.workspaceId!
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  function MountedTerminal() {
    const present = renderer((state) =>
      state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === pane.tabId)
    )
    return present ? createElement(Controller) : null
  }
  function Controller() {
    const controller = useTerminalPaneController({
      tabId: pane.tabId,
      worktreeId,
      cwd: fixture.processes.get(seed.terminalPtyId!)!.cwd,
      isActive: false,
      isVisible: true,
      onPtyExit: () => {},
      onCloseTab: () => renderer.getState().closeTab(pane.tabId)
    })
    return createElement('div', { ref: controller.containerRef })
  }
  renderer.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
  const unsubscribe = createSessionWriteSubscriber({
    store: renderer,
    persist: ({ patch }) =>
      patchWorkspaceSessionByHost(window.api.session, patch, renderer.getState()).written,
    onPersistError: (error) => {
      throw error
    }
  })
  setRuntimeGraphSyncEnabled(true)
  await act(async () => {
    root.render(
      createElement(
        LinkRoutingPreferenceDialogContext.Provider,
        { value: async () => false },
        createElement(MountedTerminal)
      )
    )
  })
  return {
    dispose: async () => {
      setRuntimeGraphSyncEnabled(false)
      unsubscribe()
      await act(async () => root.unmount())
      host.remove()
    }
  }
}
