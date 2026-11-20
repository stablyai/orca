import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { shouldShowAutomationsButton } from '@/components/sidebar/chrome/SidebarNav'
import { navigateFromRail } from './app-rail-navigation'

/** Pages that live on the rail below Workspaces, in this order. With the rail on, their list rows are not rendered. */
export const APP_RAIL_DESTINATION_IDS = ['tasks', 'automations'] as const
export type AppRailDestinationId = (typeof APP_RAIL_DESTINATION_IDS)[number]

// The same visibility preferences the list rows read.
export const selectRailTasksVisible = (s: AppState): boolean =>
  s.settings?.showTasksButton !== false
export const selectRailAutomationsVisible = (s: AppState): boolean =>
  shouldShowAutomationsButton(s.settings)

function openDestination(id: AppRailDestinationId, state: AppState): void {
  if (id === 'tasks') {
    state.openTaskPage()
  } else {
    state.openAutomationsPage()
  }
}

/**
 * Open a rail destination. From Settings this runs only after its discard check approves, and Settings closes first so
 * the destination's own Close returns to the view before Settings rather than into Settings. An already-current
 * destination is left as it is: re-opening would reset its page state.
 */
export function activateRailDestination(id: AppRailDestinationId): void {
  navigateFromRail(() => {
    if (useAppStore.getState().activeView === 'settings') {
      useAppStore.getState().closeSettingsPage()
    }
    const state = useAppStore.getState()
    if (state.activeView === id) {
      return
    }
    openDestination(id, state)
  })
}
