import type { FloatingWorkspacePanelOwnedAction } from '@/lib/floating-workspace-shortcut-policy'
import type { KeybindingActionId, PhysicalModifierToken } from '../../../../shared/keybindings'

export type FloatingWorkspaceTourInteractionSnapshot = {
  wasPreviouslyInteracted?: boolean
  persisted?: Promise<void>
  recordFeatureInteractionForTour: boolean
}

export type FloatingTerminalPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tourInteractionSnapshot?: FloatingWorkspaceTourInteractionSnapshot | null | undefined
}

export type FloatingPanelShortcutInput = Partial<
  Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
> &
  Pick<KeyboardEvent, 'target'> & { doubleTapModifier?: PhysicalModifierToken }

// 'deferred' leaves propagation intact for the terminal pane's split-close handler.
export type FloatingShortcutOutcome = 'handled' | 'deferred' | 'unmatched'

export type FloatingPanelShortcutResolution =
  | { kind: 'create'; action: Exclude<FloatingWorkspacePanelOwnedAction, 'tab.close'> }
  | { kind: 'close'; focusedFloatingTerminal: boolean }
  | { kind: 'index'; index: number }
  | { kind: 'chrome'; action: KeybindingActionId }
