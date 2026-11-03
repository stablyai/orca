import type { PluginContributionSummaryItem } from '../../../../../shared/plugins/contributions/plugin-contribution-summary'
import { nameFromContributionPath, type PluginContributionSource } from './plugin-contributions'

/** What a catalog summary names, in the same shape; theme modes come from its preview palettes. */
export function summaryContributionSource(
  summary: readonly PluginContributionSummaryItem[],
  themePreview: readonly { label: string; base: 'light' | 'dark' }[] = []
): PluginContributionSource {
  const of = (kind: PluginContributionSummaryItem['kind']) =>
    summary.filter((item) => item.kind === kind)
  const base = (label: string) => themePreview.find((theme) => theme.label === label)?.base
  return {
    themes: of('themes').map((item) => ({
      id: item.name,
      label: item.name,
      base: base(item.name)
    })),
    terminalThemes: of('terminalThemes').map((item) => ({
      id: item.name,
      label: item.name,
      mode: base(item.name)
    })),
    iconThemes: of('iconThemes').map((item) => ({ id: item.name, label: item.name })),
    sidebarCards: of('sidebarCards').map((item) => ({ id: item.name, label: item.name })),
    workspaceLists: of('workspaceLists').map((item) => ({ id: item.name, label: item.name })),
    syntaxes: of('syntaxes').map((item) => ({
      id: item.name,
      label: item.name,
      extensions: item.detail ? item.detail.split(', ') : [],
      filenames: []
    })),
    languagePacks: of('languagePacks').map((item) => ({ locale: item.name })),
    panels: of('panels').map((item) => item.name),
    customEditors: of('customEditors').map((item) => ({
      title: item.name,
      extensions: item.detail ? item.detail.split(', ') : [],
      filenames: []
    })),
    vmRecipes: of('vmRecipes').map((item) => nameFromContributionPath(item.name)),
    newFiles: of('newFiles').map((item) => ({ title: item.name, extension: item.detail ?? '' })),
    statusBarItems: of('statusBarItems').map((item) => item.name)
  }
}
