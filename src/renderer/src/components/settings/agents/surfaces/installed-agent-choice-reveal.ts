import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'
import {
  cancelSettingsListReveal,
  scrollSettingsSectionToTarget
} from '../../section-layout/settings-list-scroll'
import { AGENTS_INSTALLED_SECTION_ID } from '../agents-search'

const AVAILABLE_CHOICE = '[role="radiogroup"] [role="radio"]:not([aria-disabled="true"])'

/**
 * The Chat or CLI choice "Choose per agent" lands on: the first installed row with one that can be
 * picked, preferring its current choice. Unavailable options stay focusable but ignore clicks, and
 * disabled agents have none, so both are skipped.
 */
export function findInstalledAgentChoice(list: HTMLElement): HTMLElement | null {
  const rows = list
    .querySelector('[data-settings-group-body]')
    ?.querySelectorAll<HTMLElement>('[data-agent-opens-as]')
  for (const row of rows ?? []) {
    const choice =
      row.querySelector<HTMLElement>(`${AVAILABLE_CHOICE}[aria-checked="true"]`) ??
      row.querySelector<HTMLElement>(AVAILABLE_CHOICE)
    if (choice) {
      return choice
    }
  }
  return null
}

/** "Choose per agent": shows the Installed list and focuses a Chat or CLI choice that can be picked. */
export function revealInstalledAgentChoice(): void {
  cancelSettingsListReveal()
  const list = document.getElementById(AGENTS_INSTALLED_SECTION_ID)
  if (!list) {
    return
  }
  const choice = findInstalledAgentChoice(list)
  // The choice, not its row: an open row can be taller than the view and would push the heading off.
  // With no choice to pick, the Installed list itself is the destination.
  scrollSettingsSectionToTarget(list, choice, motionSafeScrollBehavior())
  ;(choice ?? list).focus({ preventScroll: true })
}
