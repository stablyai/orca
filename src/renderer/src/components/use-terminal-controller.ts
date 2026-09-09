import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import { useTerminalWorkspaceStoreBindings } from './use-terminal-workspace-store-bindings'
import { useTerminalWorkspaceProjection } from './use-terminal-workspace-projection'
import { useTerminalEditorCloseFoundation } from './use-terminal-editor-close-foundation'
import { useTerminalEditorCloseQueue } from './use-terminal-editor-close-queue'
import { useTerminalEditorCloseDialogActions } from './use-terminal-editor-close-dialog-actions'
import { useTerminalParkingFoundation } from './use-terminal-parking-foundation'
import { useTerminalParkingPass } from './use-terminal-parking-pass'
import { useTerminalBrowserRetention } from './use-terminal-browser-retention'
import { applyTerminalColdActivation } from './terminal-cold-activation'
import { useTerminalWatcherEffects } from './use-terminal-watcher-effects'
import { useTerminalCreateActions } from './use-terminal-create-actions'
import { useTerminalCloseActions } from './use-terminal-close-actions'
import { useTerminalBulkCloseActions } from './use-terminal-bulk-close-actions'
import { useTerminalActivationActions } from './use-terminal-activation-actions'
import { useTerminalKeyboardShortcuts } from './use-terminal-keyboard-shortcuts'
import { useTerminalWindowLifecycle } from './use-terminal-window-lifecycle'

export function useTerminalController() {
  const foundation = useTerminalWorkspaceFoundation()
  const store = Object.assign(foundation, useTerminalWorkspaceStoreBindings(foundation))
  const projection = Object.assign(store, useTerminalWorkspaceProjection(store))
  const closeFoundation = Object.assign(projection, useTerminalEditorCloseFoundation(projection))
  const closeQueue = Object.assign(closeFoundation, useTerminalEditorCloseQueue(closeFoundation))
  const editorClose = Object.assign(closeQueue, useTerminalEditorCloseDialogActions(closeQueue))
  const parking = Object.assign(editorClose, useTerminalParkingFoundation(editorClose))
  useTerminalParkingPass(parking)
  useTerminalBrowserRetention(parking)
  const coldActivation = Object.assign(parking, applyTerminalColdActivation(parking))
  useTerminalWatcherEffects(coldActivation)
  const create = Object.assign(coldActivation, useTerminalCreateActions(coldActivation))
  const close = Object.assign(create, useTerminalCloseActions(create))
  const bulkClose = Object.assign(close, useTerminalBulkCloseActions(close))
  const activation = Object.assign(bulkClose, useTerminalActivationActions(bulkClose))
  useTerminalKeyboardShortcuts(activation)
  useTerminalWindowLifecycle(activation)
  return activation
}

export type TerminalController = ReturnType<typeof useTerminalController>
