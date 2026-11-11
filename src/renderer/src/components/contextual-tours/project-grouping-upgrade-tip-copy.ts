import { translate } from '@/i18n/i18n'
import type { LocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

export function getProjectGroupingUpgradeTipCopy(): LocalizedContextualTourStepCopy {
  return {
    title: '',
    body: translate(
      'settings.projectGrouping.upgrade.body',
      'Orca now groups multiple checkouts of the same repo into one project.'
    )
  }
}
