import { translate } from '@/i18n/i18n'
import type { PluginContribution } from './plugin-contributions'

export function withMode(
  kindLabel: string,
  mode: 'light' | 'dark' | 'unknown' | undefined
): string {
  if (mode === 'dark') {
    return `${kindLabel} · ${translate('auto.components.settings.pluginContributions.dark', 'Dark')}`
  }
  if (mode === 'light') {
    return `${kindLabel} · ${translate('auto.components.settings.pluginContributions.light', 'Light')}`
  }
  return kindLabel
}

/** Each item's text, or its id when it shows only an icon. */
export function statusBarItemTitles(
  items: readonly { id: string; text?: string }[] | undefined
): string[] {
  return (items ?? []).map((item) => item.text || item.id)
}

export function statusBarContributionRows(titles: readonly string[]): PluginContribution[] {
  const detail = translate('auto.components.settings.pluginContributions.statusBar', 'Status bar')
  return titles.map((title, index) => ({
    key: `statusBarItems:${index}`,
    kind: 'statusBarItems',
    title,
    detail,
    tone: 'default'
  }))
}
