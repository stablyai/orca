import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'
import {
  cancelSettingsListReveal,
  scrollSettingsSectionToTarget
} from '../../section-layout/settings-list-scroll'
import { AGENTS_INSTALLED_SECTION_ID } from '../agents-search'

/** "Choose per agent": shows the Installed list and focuses the first row's Chat or CLI choice. */
export function revealInstalledAgentChoice(): void {
  cancelSettingsListReveal()
  const list = document.getElementById(AGENTS_INSTALLED_SECTION_ID)
  if (!list) {
    return
  }
  const row = list
    .querySelector('[data-settings-group-body]')
    ?.querySelector<HTMLElement>('[data-agent-opens-as]')
  const choice =
    row?.querySelector<HTMLElement>('[role="radiogroup"] [aria-checked="true"]') ??
    row?.querySelector<HTMLElement>('[role="radiogroup"] [role="radio"]') ??
    null
  // The choice, not its row: an open row can be taller than the view and would push the heading off.
  scrollSettingsSectionToTarget(list, choice, motionSafeScrollBehavior())
  ;(choice ?? list).focus({ preventScroll: true })
}
