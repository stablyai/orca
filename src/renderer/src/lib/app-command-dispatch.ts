import { isKeybindingActionId, type KeybindingActionId } from '../../../shared/keybindings'

export type AppCommandSource = 'plugin-keybinding' | 'plugin-palette'
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

export function dispatchAppCommand(actionId: string, source: AppCommandSource): boolean {
  return isKeybindingActionId(actionId) && currentDispatcher !== null
    ? currentDispatcher(actionId, source)
    : false
}
