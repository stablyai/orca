import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import {
  shouldShowArtifactsButton,
  shouldShowAutomationsButton,
  shouldShowMobileButton,
  shouldShowSkillsButton
} from '@/components/sidebar/chrome/SidebarNav'
import { navigateFromRail } from './app-rail-navigation'

/** Pages that live on the rail below Workspaces, in this order. With the rail on, their list rows are not rendered. */
export const APP_RAIL_DESTINATION_IDS = [
  'tasks',
  'automations',
  'artifacts',
  'skills',
  'mobile'
] as const
export type AppRailDestinationId = (typeof APP_RAIL_DESTINATION_IDS)[number]

// The same visibility preferences the list rows read.
const DESTINATION_VISIBLE: Record<
  AppRailDestinationId,
  (settings: AppState['settings']) => boolean
> = {
  tasks: (settings) => settings?.showTasksButton !== false,
  automations: shouldShowAutomationsButton,
  artifacts: shouldShowArtifactsButton,
  skills: shouldShowSkillsButton,
  mobile: shouldShowMobileButton
}

const DESTINATION_OPEN: Record<AppRailDestinationId, (state: AppState) => void> = {
  tasks: (state) => state.openTaskPage(),
  automations: (state) => state.openAutomationsPage(),
  artifacts: (state) => state.openArtifactsPage(),
  skills: (state) => state.openSkillsPage(),
  mobile: (state) => state.openMobilePage()
}

function isRailDestinationId(value: string): value is AppRailDestinationId {
  return APP_RAIL_DESTINATION_IDS.some((id) => id === value)
}

/** Shown destinations in rail order, joined into one string so the subscription compares a primitive. */
export const selectShownRailDestinationsKey = (s: AppState): string =>
  APP_RAIL_DESTINATION_IDS.filter((id) => DESTINATION_VISIBLE[id](s.settings)).join(',')

export function shownRailDestinationsFromKey(key: string): AppRailDestinationId[] {
  const shown = key.split(',')
  return APP_RAIL_DESTINATION_IDS.filter((id) => shown.includes(id))
}

export const selectCurrentRailDestination = (s: AppState): AppRailDestinationId | null =>
  isRailDestinationId(s.activeView) ? s.activeView : null

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
    DESTINATION_OPEN[id](state)
  })
}
