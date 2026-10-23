import type { ContextualTourId } from '../../../../shared/contextual-tours'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

/** Whether the active pane's header buttons stay hidden until hovered or focused. */
export function resolvePaneHeaderButtonsOnHover(
  mode: GlobalSettings['terminalPaneHeaderButtons'] | undefined,
  activeContextualTourId: ContextualTourId | null
): boolean {
  // Why: this tour points at the active pane's split button; hidden, its arrow points at nothing.
  return mode === 'hover' && activeContextualTourId !== 'workspace-agent-sessions'
}
