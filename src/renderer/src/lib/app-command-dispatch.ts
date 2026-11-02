import { isKeybindingActionId, type KeybindingActionId } from '../../../shared/keybindings'

export type AppCommandSource = 'plugin-keybinding' | 'plugin-palette' | 'plugin-host'
export type AppCommandDispatcher = (
  actionId: KeybindingActionId,
  source: AppCommandSource
) => boolean

let currentDispatcher: AppCommandDispatcher | null = null

export function registerAppCommandDispatcher(dispatcher: AppCommandDispatcher): () => void {
  currentDispatcher = dispatcher
  return () => {
    if (currentDispatcher === dispatcher) {
      currentDispatcher = null
    }
  }
}

/** Runs Orca's own handler for the action; plugin commands that replace it never run here. */
export function dispatchAppCommand(actionId: string, source: AppCommandSource): boolean {
  return isKeybindingActionId(actionId) && currentDispatcher !== null
    ? currentDispatcher(actionId, source)
    : false
}
