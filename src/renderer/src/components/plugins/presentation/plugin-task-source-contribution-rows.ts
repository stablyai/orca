import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  describePluginContributions,
  type PluginContribution,
  type PluginContributionSource
} from './plugin-contributions'

function taskSourceContributionRows(titles: readonly string[]): PluginContribution[] {
  const detail = translate('auto.components.settings.PluginDetailSections.taskSource', 'Task list')
  return titles.map((title, index) => ({
    key: `taskSources:${index}`,
    kind: 'taskSources',
    title,
    detail,
    tone: 'default'
  }))
}

/** The plugin's contribution rows, with the task lists it adds after the rest. */
export function describePluginContributionsWithTaskSources(
  source: PluginContributionSource,
  t: Translate = translate,
  intlLocale?: string
): PluginContribution[] {
  return [
    ...describePluginContributions(source, t, intlLocale),
    ...taskSourceContributionRows(source.taskSources ?? [])
  ]
}
