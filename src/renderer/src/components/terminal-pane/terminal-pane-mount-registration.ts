import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { registerRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { removeTerminalPresentation } from './terminal-presentation-retirement'
import type { PaneClosedHandlerContext } from './terminal-pane-mount-context'

/** The mount retains its actual manager even while the rendering ref is temporarily cleared. */
export function registerTerminalPaneMount(
  context: Pick<PaneClosedHandlerContext, 'deps' | 'refs' | 'deferredSplitHandoffs'>,
  onEmpty: (manager: PaneManager) => void
) {
  const { deps } = context
  let ownedManager: PaneManager | null = null
  const unregisterRuntimeTab = registerRuntimeTerminalTab({
    retirePresentation: (original) => {
      const manager = ownedManager
      const pane = manager?.getPanes().find((candidate) => candidate.leafId === original.leafId)
      const transport = pane ? deps.paneTransportsRef.current.get(pane.id) : null
      if (transport?.getPtyId() && transport.getPtyId() !== original.ptyId) {
        throw new Error('terminal_pane_owner_changed')
      }
      if (
        !pane &&
        [...deps.paneTransportsRef.current.values()].some(
          (candidate) => !manager || candidate.getPtyId() === original.ptyId
        )
      ) {
        throw new Error('terminal_pane_owner_unavailable')
      }
      removeTerminalPresentation(original, (failures) => {
        if (pane && manager) {
          const structuralFailures: unknown[] = []
          try {
            if (!manager.retirePanePreservingPty(pane.id, true, failures)) {
              throw new Error('terminal_pane_close_failed')
            }
          } catch (error) {
            structuralFailures.push(error)
          } finally {
            if (manager.getPanes().length === 0) {
              try {
                onEmpty(manager)
              } catch (error) {
                structuralFailures.push(error)
              } finally {
                if (deps.managerRef.current === manager) {
                  deps.managerRef.current = null
                }
                ownedManager = null
                unregisterRuntimeTab()
              }
            }
          }
          if (structuralFailures.length === 1) {
            throw structuralFailures[0]
          }
          if (structuralFailures.length > 1) {
            throw new AggregateError(structuralFailures, 'terminal_tab_close_failed')
          }
        }
      })
    },
    tabId: deps.tabId,
    worktreeId: deps.worktreeId,
    getManager: () => deps.managerRef.current,
    getContainer: () => deps.containerRef.current,
    getPtyIdForPane: (paneId) => deps.paneTransportsRef.current.get(paneId)?.getPtyId() ?? null,
    getTabWideAgentHintLeafId: deps.getTabWideAgentHintLeafId
  })
  return {
    unregisterRuntimeTab,
    getOwnedManager: () => ownedManager,
    setOwnedManager: (manager: PaneManager) => {
      ownedManager = manager
    }
  }
}
