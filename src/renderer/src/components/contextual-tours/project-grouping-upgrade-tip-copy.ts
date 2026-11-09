import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getProjectGroupingIndexFromState } from '@/store/projects/project-host-setup-selector'
import type { LocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

/** Counts the combined projects, naming the project when there is only one. */
export function getProjectGroupingUpgradeTipCopy(): LocalizedContextualTourStepCopy {
  const state = useAppStore.getState()
  const audience = state.projectGroupingUpgradeTipAudience
  const eligible = audience?.membership === 'eligible' ? audience : null
  const group = eligible
    ? getProjectGroupingIndexFromState(state).groupByKey.get(`project:${eligible.projectId}`)
    : undefined
  return {
    title: translate('settings.projectGrouping.upgrade.title', 'Your checkouts were combined'),
    body:
      eligible?.projectCount === 1
        ? translate(
            'settings.projectGrouping.upgrade.bodyProject',
            'For {{project}}, Orca now groups multiple checkouts of the same repo into one project.',
            { project: group?.label ?? '' }
          )
        : translate(
            'settings.projectGrouping.upgrade.bodyProjects',
            'For {{count}} projects, Orca now groups multiple checkouts of the same repo into one project.',
            { count: eligible?.projectCount ?? 0 }
          ),
    primaryActionLabel: translate('settings.projectGrouping.upgrade.gotIt', 'Got it')
  }
}
