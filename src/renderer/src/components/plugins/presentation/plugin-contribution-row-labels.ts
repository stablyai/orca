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
export function pluginItemTitles(
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

export function composerItemContributionRows(
  titles: readonly string[],
  t: Translate
): PluginContribution[] {
  const detail = t('components.plugins.composerItems', 'Chat composer')
  return titles.map((title, index) => ({
    key: `composerItems:${index}`,
    kind: 'composerItems',
    title,
    detail,
    tone: 'default'
  }))
}

export function newFileContributionRows(
  files: readonly { title: string; extension: string }[],
  t: Translate
): PluginContribution[] {
  const label = t('auto.components.settings.pluginContributions.newFileMenu', 'Adds to the + menu')
  return files.map(({ title, extension }, index) => ({
    key: `newFiles:${index}`,
    kind: 'newFiles',
    title,
    detail: extension ? `${label} · ${extension}` : label,
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

/** Each server with its URL or the command line that starts it, so a review shows what runs. */
export function mcpServerContributionRows(
  servers: readonly { name: string; detail: string }[],
  t: Translate = translate
): PluginContribution[] {
  const label = t('auto.components.settings.PluginDetailSections.mcpServer', 'MCP server')
  return servers.map((server, index) => ({
    key: `mcpServers:${index}`,
    kind: 'mcpServers',
    title: server.name,
    detail: server.detail ? `${label} · ${server.detail}` : label,
    tone: 'default'
  }))
}

export function vmRecipeContributionRows(
  titles: readonly string[],
  t: Translate = translate
): PluginContribution[] {
  const detail = t('auto.components.settings.PluginDetailSections.recipe', 'Machine recipe')
  return titles.map((title, index) => ({
    key: `vmRecipes:${index}`,
    kind: 'vmRecipes',
    title,
    detail,
    tone: 'default'
  }))
}
