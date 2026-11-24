import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import { useTerminalWorkspaceStoreBindings } from './use-terminal-workspace-store-bindings'
import { useTerminalWorkspaceProjection } from './use-terminal-workspace-projection'
import { useTerminalEditorCloseFoundation } from '../workspace-files/use-terminal-editor-close-foundation'
import { useTerminalEditorCloseQueue } from '../workspace-files/use-terminal-editor-close-queue'
import { useTerminalEditorCloseDialogActions } from '../workspace-files/use-terminal-editor-close-dialog-actions'
import { useTerminalParkingFoundation } from '../workspace-mounting/use-terminal-parking-foundation'
import { useTerminalParkingPass } from '../workspace-mounting/use-terminal-parking-pass'
import { useTerminalBrowserRetention } from '../workspace-mounting/use-terminal-browser-retention'
import { applyTerminalColdActivation } from '../workspace-mounting/terminal-cold-activation'
import { useActivationDeferredTabAdmission } from '../workspace-mounting/use-activation-deferred-tab-admission'
import { useTerminalWorktreePrewarm } from '../worktree-prewarm/use-terminal-worktree-prewarm'
import { useTerminalWatcherEffects } from './use-terminal-watcher-effects'
import { useTerminalCreateActions } from '../tab-lifecycle/use-terminal-create-actions'
import { useTerminalCloseActions } from '../tab-lifecycle/use-terminal-close-actions'
import { useTerminalBulkCloseActions } from '../tab-lifecycle/use-terminal-bulk-close-actions'
import { useTerminalActivationActions } from '../tab-lifecycle/use-terminal-activation-actions'
import { useTerminalKeyboardShortcuts } from '../keyboard-shortcuts/use-terminal-keyboard-shortcuts'
import { useTerminalWindowLifecycle } from '../tab-lifecycle/use-terminal-window-lifecycle'

export function useTerminalController() {
  const foundation = useTerminalWorkspaceFoundation()
  const store = Object.assign(foundation, useTerminalWorkspaceStoreBindings(foundation))
  const projection = Object.assign(store, useTerminalWorkspaceProjection(store))
  const closeFoundation = Object.assign(projection, useTerminalEditorCloseFoundation(projection))
  const closeQueue = Object.assign(closeFoundation, useTerminalEditorCloseQueue(closeFoundation))
  const editorClose = Object.assign(closeQueue, useTerminalEditorCloseDialogActions(closeQueue))
  const parking = Object.assign(editorClose, useTerminalParkingFoundation(editorClose))
  useTerminalParkingPass(parking)
  useTerminalBrowserRetention()
  const coldActivation = Object.assign(parking, applyTerminalColdActivation(parking))
  useTerminalWatcherEffects(coldActivation)
  useActivationDeferredTabAdmission(coldActivation)
  useTerminalWorktreePrewarm(coldActivation)
  const create = Object.assign(coldActivation, useTerminalCreateActions(coldActivation))
  const close = Object.assign(create, useTerminalCloseActions(create))
  const bulkClose = Object.assign(close, useTerminalBulkCloseActions(close))
  const activation = Object.assign(bulkClose, useTerminalActivationActions(bulkClose))
  useTerminalKeyboardShortcuts(activation)
  useTerminalWindowLifecycle(activation)
  return activation
}

export type TerminalController = ReturnType<typeof useTerminalController>
