import type { TerminalPaneHandle, TerminalPaneProps } from './terminal-pane-types'
import { useTerminalPaneFoundation } from './use-terminal-pane-foundation'
import { useTerminalPaneTitleState } from './use-terminal-pane-title-state'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneStoreBindings } from './use-terminal-pane-store-bindings'
import { useTerminalPaneStartupActions } from './use-terminal-pane-startup-actions'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { useTerminalPaneLayoutBindings } from './use-terminal-pane-layout-bindings'
import { useTerminalPaneCloseActions } from './use-terminal-pane-close-actions'
import { useTerminalPaneLifecycleStage } from './use-terminal-pane-lifecycle-stage'
import { useTerminalPaneReconciliation } from './use-terminal-pane-reconciliation'
import { useTerminalPaneGlobalListeners } from './use-terminal-pane-global-listeners'
import { useTerminalPanePasteListeners } from './use-terminal-pane-paste-listeners'
import { useTerminalPaneTitleEffects } from './use-terminal-pane-title-effects'
import { useTerminalPaneContextActions } from './use-terminal-pane-context-actions'
import { useTerminalPaneMobileActions } from './use-terminal-pane-mobile-actions'
import { useTerminalPaneProjection } from './use-terminal-pane-projection'

export function useTerminalPaneController(
  props: TerminalPaneProps,
  ref: React.ForwardedRef<TerminalPaneHandle>
) {
  const foundation = useTerminalPaneFoundation(props, ref)
  const title = Object.assign(foundation, useTerminalPaneTitleState(foundation))
  const chat = Object.assign(title, useTerminalPaneChatState(title))
  const store = Object.assign(chat, useTerminalPaneStoreBindings(chat))
  const startup = Object.assign(store, useTerminalPaneStartupActions(store))
  const layout = Object.assign(startup, useTerminalPaneLayoutPersistence(startup))
  const bindings = Object.assign(layout, useTerminalPaneLayoutBindings(layout))
  const close = Object.assign(bindings, useTerminalPaneCloseActions(bindings))
  useTerminalPaneLifecycleStage(close)
  const reconciliation = Object.assign(close, useTerminalPaneReconciliation(close))
  useTerminalPaneGlobalListeners(reconciliation)
  useTerminalPanePasteListeners(reconciliation)
  useTerminalPaneTitleEffects(reconciliation)
  const context = Object.assign(reconciliation, useTerminalPaneContextActions(reconciliation))
  const mobile = Object.assign(context, useTerminalPaneMobileActions(context))
  return Object.assign(mobile, useTerminalPaneProjection(mobile))
}

export type TerminalPaneController = ReturnType<typeof useTerminalPaneController>
