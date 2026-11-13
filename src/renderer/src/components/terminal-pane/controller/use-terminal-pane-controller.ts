import type { TerminalPaneProps } from './terminal-pane-types'
import { useTerminalPaneFoundation } from './use-terminal-pane-foundation'
import { useTerminalPaneTitleState } from '../titles/use-terminal-pane-title-state'
import { useTerminalPaneChatState } from '../chat/use-terminal-pane-chat-state'
import { useTerminalPaneStoreBindings } from './use-terminal-pane-store-bindings'
import { useTerminalPaneStartupActions } from './use-terminal-pane-startup-actions'
import { useTerminalPaneLayoutPersistence } from '../layout/persistence/use-terminal-pane-layout-persistence'
import { useTerminalPaneLayoutBindings } from '../layout/ownership/use-terminal-pane-layout-bindings'
import { useHostPaneTitleSync } from '../titles/use-host-pane-title-sync'
import { useTerminalPaneCloseActions } from '../layout/close/use-terminal-pane-close-actions'
import { useTerminalPaneTabDetachActions } from '../layout/detach/use-terminal-pane-tab-detach-actions'
import { useTerminalPaneLifecycleStage } from '../mounting/use-terminal-pane-lifecycle-stage'
import { useTerminalPaneReconciliation } from './use-terminal-pane-reconciliation'
import { useTerminalPaneGlobalListeners } from './use-terminal-pane-global-listeners'
import { useTerminalPanePasteListeners } from '../input/paste/use-terminal-pane-paste-listeners'
import { useTerminalPaneTitleEffects } from './use-terminal-pane-title-effects'
import { useTerminalPaneContextActions } from './use-terminal-pane-context-actions'
import { useTerminalPaneMobileActions } from './use-terminal-pane-mobile-actions'
import { useTerminalPaneProjection } from './use-terminal-pane-projection'
import { useLayoutOwnerPaneTree } from '../layout/ownership/use-layout-owner-pane-tree'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

// Switch point: the mounted tab follows main's pane tree. Chosen once per build, so hook order is fixed.
const useLayoutOwnerPaneTreeWhenMain = ORCA_LAYOUT_OWNER_IS_MAIN
  ? useLayoutOwnerPaneTree
  : (): void => {}

export function useTerminalPaneController(props: TerminalPaneProps) {
  const foundation = useTerminalPaneFoundation(props)
  const title = Object.assign(foundation, useTerminalPaneTitleState(foundation))
  const chat = Object.assign(title, useTerminalPaneChatState(title))
  const store = Object.assign(chat, useTerminalPaneStoreBindings(chat))
  const startup = Object.assign(store, useTerminalPaneStartupActions(store))
  const layout = Object.assign(startup, useTerminalPaneLayoutPersistence(startup))
  const bindings = Object.assign(layout, useTerminalPaneLayoutBindings(layout))
  const close = Object.assign(
    bindings,
    useTerminalPaneCloseActions(bindings),
    useTerminalPaneTabDetachActions(bindings)
  )
  const mounted = Object.assign(close, useTerminalPaneLifecycleStage(close))
  useHostPaneTitleSync(mounted)
  const reconciliation = Object.assign(mounted, useTerminalPaneReconciliation(mounted))
  useLayoutOwnerPaneTreeWhenMain(mounted)
  useTerminalPaneGlobalListeners(reconciliation)
  useTerminalPanePasteListeners(reconciliation)
  useTerminalPaneTitleEffects(reconciliation)
  const context = Object.assign(reconciliation, useTerminalPaneContextActions(reconciliation))
  const mobile = Object.assign(context, useTerminalPaneMobileActions(context))
  return Object.assign(mobile, useTerminalPaneProjection(mobile))
}

export type TerminalPaneController = ReturnType<typeof useTerminalPaneController>
