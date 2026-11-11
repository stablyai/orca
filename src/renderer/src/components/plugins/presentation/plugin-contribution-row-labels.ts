import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { PluginContribution, PluginContributionSource } from './plugin-contributions'

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

/** One row per worktree badge title, each described as a badge beside matching workspaces. */
export function worktreeBadgeContributionRows(
  titles: readonly string[],
  t: Translate = translate
): PluginContribution[] {
  const detail = t(
    'auto.components.settings.pluginContributions.worktreeBadge',
    'Badge beside matching workspaces'
  )
  return titles.map((title, index) => ({
    key: `worktreeBadges:${index}`,
    kind: 'worktreeBadges',
    title,
    detail,
    tone: 'default'
  }))
}

/** Rows for what a plugin adds to Orca's chrome: status bar items, then workspace badges. */
export function chromeContributionRows(
  source: Pick<PluginContributionSource, 'statusBarItems' | 'worktreeBadges'>,
  t: Translate = translate
): PluginContribution[] {
  return [
    ...statusBarContributionRows(source.statusBarItems, t),
    ...worktreeBadgeContributionRows(source.worktreeBadges, t)
  ]
}
