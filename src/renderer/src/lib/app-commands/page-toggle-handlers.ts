import type { AppState } from '@/store/types'
import type { KeybindingActionId } from '../../../../shared/keybindings/types'

type PageToggleActionId = Extract<KeybindingActionId, 'view.automations' | 'view.activity'>

/** Opens the page, or returns to the previous view when it is already showing; never from Settings. */
export function createPageToggleHandlers(
  activeView: AppState['activeView'],
  getState: () => AppState,
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): [PageToggleActionId, () => boolean][] {
  const toggle = (
    actionId: PageToggleActionId,
    view: 'automations' | 'activity'
  ): [PageToggleActionId, () => boolean] => [
    actionId,
    () => {
      if (activeView === 'settings') {
        return false
      }
      const store = getState()
      const open = view === 'automations' ? store.openAutomationsPage : store.openActivityPage
      const close = view === 'automations' ? store.closeAutomationsPage : store.closeActivityPage
      return claim(actionId, activeView === view ? close : open)
    }
  ]
  return [toggle('view.automations', 'automations'), toggle('view.activity', 'activity')]
}
