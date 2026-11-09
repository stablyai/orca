import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { PluginContribution } from './plugin-contributions'

export function withMode(
  kindLabel: string,
  mode: 'light' | 'dark' | 'unknown' | undefined,
  t: Translate = translate
): string {
  if (mode === 'dark') {
    return `${kindLabel} · ${t('auto.components.settings.pluginContributions.dark', 'Dark')}`
  }
  if (mode === 'light') {
    return `${kindLabel} · ${t('auto.components.settings.pluginContributions.light', 'Light')}`
  }
  return kindLabel
}

/** Each item's text, or its id when it shows only an icon. */
export function statusBarItemTitles(
  items: readonly { id: string; text?: string }[] | undefined
): string[] {
  return (items ?? []).map((item) => item.text || item.id)
}

export function statusBarContributionRows(
  titles: readonly string[],
  t: Translate = translate
): PluginContribution[] {
  const detail = t('auto.components.settings.pluginContributions.statusBar', 'Status bar')
  return titles.map((title, index) => ({
    key: `statusBarItems:${index}`,
    kind: 'statusBarItems',
    title,
    detail,
    tone: 'default'
  }))
}

export function fontContributionRows(
  families: readonly string[],
  t: Translate = translate
): PluginContribution[] {
  const detail = t(
    'auto.components.settings.pluginContributions.font',
    'Font for the terminal, editor or interface'
  )
  return families.map((title, index) => ({
    key: `fonts:${index}`,
    kind: 'fonts',
    title,
    detail,
    tone: 'default'
  }))
}

export function taskSourceContributionRows(titles: readonly string[]): PluginContribution[] {
  const detail = translate('auto.components.settings.PluginDetailSections.taskSource', 'Task list')
  return titles.map((title, index) => ({
    key: `taskSources:${index}`,
    kind: 'taskSources',
    title,
    detail,
    tone: 'default'
  }))
}
