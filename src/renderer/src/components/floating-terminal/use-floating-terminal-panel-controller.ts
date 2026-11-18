import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { createFloatingTerminalPanelDragActions } from './geometry/floating-terminal-panel-drag-actions'
import type { FloatingTerminalPanelProps } from './state/floating-terminal-panel-types'
import { useFloatingTerminalCloseActions } from './workspace/use-floating-terminal-close-actions'
import { useFloatingTerminalCreateActions } from './workspace/use-floating-terminal-create-actions'
import { useFloatingTerminalFocusLifecycle } from './focus/use-floating-terminal-focus-lifecycle'
import { useFloatingTerminalGlobalShortcutListeners } from './shortcuts/use-floating-terminal-global-shortcut-listeners'
import { useFloatingTerminalGuestBridge } from './workspace/use-floating-terminal-guest-bridge'
import { useFloatingTerminalInitialFocusEffects } from './focus/use-floating-terminal-initial-focus-effects'
import { useFloatingTerminalOrchestrationDismissal } from './orchestration/use-floating-terminal-orchestration-dismissal'
import { useFloatingTerminalOrchestrationVisibility } from './orchestration/use-floating-terminal-orchestration-visibility'
import { useFloatingTerminalPanelFocusReclaim } from './focus/use-floating-terminal-panel-focus-reclaim'
import { useFloatingTerminalPanelGeometry } from './geometry/use-floating-terminal-panel-geometry'
import { useFloatingWorkspaceChromeModel } from './workspace/use-floating-workspace-chrome-model'
import { useFloatingTerminalPanelLocalState } from './state/use-floating-terminal-panel-local-state'
import { useFloatingTerminalPanelMaximize } from './geometry/use-floating-terminal-panel-maximize'
import { useFloatingTerminalPanelShortcuts } from './shortcuts/use-floating-terminal-panel-shortcuts'
import { useFloatingTerminalPanelStoreState } from './state/use-floating-terminal-panel-store-state'
import { useFloatingTerminalShortcutDetails } from './shortcuts/use-floating-terminal-shortcut-details'

export function useFloatingTerminalPanelController({
  open,
  onOpenChange,
  tourInteractionSnapshot
}: FloatingTerminalPanelProps) {
  const storeState = useFloatingTerminalPanelStoreState()
  const shortcutDetails = useFloatingTerminalShortcutDetails()
  const localState = useFloatingTerminalPanelLocalState()
  const items = useFloatingWorkspaceChromeModel()

  useContextualTour('floating-workspace', open, 'floating_workspace_visible', {
    recordFeatureInteraction: tourInteractionSnapshot?.recordFeatureInteractionForTour ?? false,
    featureInteractionPersisted: tourInteractionSnapshot?.persisted,
    wasFeaturePreviouslyInteracted: tourInteractionSnapshot?.wasPreviouslyInteracted
  })

  const geometry = useFloatingTerminalPanelGeometry({ ...storeState, ...localState })
  useFloatingTerminalInitialFocusEffects({ ...items, ...localState, open })
  const orchestrationVisibility = useFloatingTerminalOrchestrationVisibility({
    ...localState,
    open
  })
  const createActions = useFloatingTerminalCreateActions({
    ...storeState,
    ...localState,
    ...items
  })
  const closeActions = useFloatingTerminalCloseActions({
    ...items
  })
  const focusReclaim = useFloatingTerminalPanelFocusReclaim({
    ...storeState,
    ...localState,
    ...items
  })
  const maximize = useFloatingTerminalPanelMaximize({ ...storeState, ...localState, open })
  const shortcuts = useFloatingTerminalPanelShortcuts({
    ...localState,
    ...items,
    ...createActions,
    ...closeActions,
    ...maximize,
    open,
    onOpenChange
  })
  useFloatingTerminalGlobalShortcutListeners({ ...localState, ...shortcuts, open })
  useFloatingTerminalGuestBridge({ ...shortcuts, open })
  useFloatingTerminalFocusLifecycle({ ...localState, ...items, open })
  const dragActions = createFloatingTerminalPanelDragActions({
    ...localState,
    ...geometry,
    ...focusReclaim,
    ...maximize
  })
  const orchestrationDismissal = useFloatingTerminalOrchestrationDismissal(localState)

  return {
    open,
    onOpenChange,
    ...storeState,
    ...shortcutDetails,
    ...localState,
    ...items,
    ...geometry,
    ...orchestrationVisibility,
    ...createActions,
    ...closeActions,
    ...focusReclaim,
    ...maximize,
    ...shortcuts,
    ...dragActions,
    ...orchestrationDismissal
  }
}
