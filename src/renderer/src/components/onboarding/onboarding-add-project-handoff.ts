import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

/** Profiles that started on the landing page finish onboarding in Add Project, including Help replays. */
export function selectOnboardingOpensAddProject(state: AppState): boolean {
  return state.settings?.telemetry?.firstLaunchLayout === 'project-picker'
}

export function completionBusyLabel(path: 'workspace' | 'add_project_modal'): string {
  return path === 'workspace'
    ? translate('components.onboarding.flow.actions.continue', 'Continue')
    : translate('components.onboarding.flow.actions.openingAddProject', 'Opening Add Project...')
}
