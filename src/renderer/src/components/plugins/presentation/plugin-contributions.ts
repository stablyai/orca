import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import { PLUGIN_LANGUAGE_PACK_MIN_COVERAGE } from '../../../../../shared/plugins/languages/plugin-language-pack-coverage'
import type { PluginContributionSummaryItem } from '../../../../../shared/plugins/contributions/plugin-contribution-summary'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  type PluginContributionPoint
} from '../../../../../shared/plugins/contributions/plugin-contribution-points'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { getIntlLocale, translate } from '@/i18n/i18n'

/** The manifest points shown as named rows; commands, shortcuts and events have their own lists. */
export type PluginContributionKind = Exclude<
  PluginContributionPoint,
  'commands' | 'keybindings' | 'events'
>

/** One named thing a plugin adds, ready to show as a row. */
export type PluginContribution = {
  key: string
  kind: PluginContributionKind
  title: string
  detail: string
  tone: 'default' | 'warning' | 'destructive'
}

/** What a plugin adds, minus commands, from either its manifest or Orca's live registrations. */
export type PluginContributionSource = {
  themes: readonly { id: string; label: string; base?: 'light' | 'dark' }[]
  terminalThemes: readonly { id: string; label: string; mode?: 'light' | 'dark' | 'unknown' }[]
  iconThemes: readonly { id: string; label: string }[]
  syntaxes: readonly {
    id: string
    label: string
    extensions: readonly string[]
    filenames: readonly string[]
    failed?: boolean
  }[]
  /** Coverage is known only once a pack is installed. */
  languagePacks: readonly { locale: string; coverage?: number }[]
  panels: readonly string[]
  customEditors: readonly {
    title: string
    extensions: readonly string[]
    filenames: readonly string[]
  }[]
  vmRecipes: readonly string[]
  newFiles: readonly { title: string; extension: string }[]
}

export const EMPTY_CONTRIBUTION_SOURCE: PluginContributionSource = {
  themes: [],
  terminalThemes: [],
  iconThemes: [],
  syntaxes: [],
  languagePacks: [],
  panels: [],
  customEditors: [],
  vmRecipes: [],
  newFiles: []
}

const FILE_LIST_LIMIT = 4

/** "recipes/ubuntu-dev.json" → "Ubuntu dev"; manifests name these files by path only. */
export function nameFromContributionPath(path: string): string {
  const file = path.split('/').pop() ?? path
  const words = file
    .replace(/\.json$/i, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path
}

export function languageDisplayName(locale: string): string {
  try {
    return new Intl.DisplayNames(getIntlLocale(), { type: 'language' }).of(locale) ?? locale
  } catch {
    return locale
  }
}

export function manifestContributionSource(manifest: PluginManifest): PluginContributionSource {
  const { contributes } = manifest
  // Why label: the source shares the shape of Orca's live registrations, which name it so.
  const titled = <Item extends { title: string }>({ title, ...item }: Item) => ({
    ...item,
    label: title
  })
  return {
    themes: contributes.themes.map(titled),
    terminalThemes: contributes.terminalThemes.map(titled),
    iconThemes: contributes.iconThemes.map(titled),
    syntaxes: contributes.syntaxes.map(titled),
    languagePacks: contributes.languagePacks,
    panels: contributes.panels.map((panel) => panel.title),
    customEditors: contributes.customEditors,
    vmRecipes: contributes.vmRecipes.map((recipe) => nameFromContributionPath(recipe.path)),
    newFiles: contributes.newFiles
  }
}

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
    newFiles: of('newFiles').map((item) => ({ title: item.name, extension: item.detail ?? '' }))
  }
}

function withMode(kindLabel: string, mode: 'light' | 'dark' | 'unknown' | undefined): string {
  if (mode === 'dark') {
    return `${kindLabel} · ${translate('auto.components.settings.pluginContributions.dark', 'Dark')}`
  }
  if (mode === 'light') {
    return `${kindLabel} · ${translate('auto.components.settings.pluginContributions.light', 'Light')}`
  }
  return kindLabel
}

function fileList(extensions: readonly string[], filenames: readonly string[]): string {
  const files = [...extensions, ...filenames]
  const shown = files.slice(0, FILE_LIST_LIMIT).join(', ')
  return files.length > FILE_LIST_LIMIT ? `${shown} +${files.length - FILE_LIST_LIMIT}` : shown
}

function languageDetail(coverage: number | undefined): Pick<PluginContribution, 'detail' | 'tone'> {
  const label = translate(
    'auto.components.settings.PluginDetailSections.typeLanguagePack',
    'Interface language'
  )
  if (coverage === undefined) {
    return { detail: label, tone: 'default' }
  }
  if (coverage < PLUGIN_LANGUAGE_PACK_MIN_COVERAGE) {
    return {
      detail: translate(
        'auto.components.settings.pluginContributions.languageIncomplete',
        '{{value0}}% translated, too incomplete to use as Orca’s language',
        { value0: coverage }
      ),
      tone: 'warning'
    }
  }
  return {
    detail: translate(
      'auto.components.settings.pluginContributions.languageCoverage',
      'Interface language · {{value0}}% translated',
      { value0: coverage }
    ),
    tone: 'default'
  }
}

/** Every named contribution as a row, in the order a reader scans: looks, languages, then UI. */
export function describePluginContributions(
  source: PluginContributionSource
): PluginContribution[] {
  const rows: PluginContribution[] = []
  for (const theme of source.themes) {
    rows.push({
      key: `themes:${theme.id}`,
      kind: 'themes',
      title: theme.label,
      detail: withMode(
        translate('auto.components.settings.PluginDetailSections.typeAppTheme', 'App theme'),
        theme.base
      ),
      tone: 'default'
    })
  }
  for (const theme of source.terminalThemes) {
    rows.push({
      key: `terminalThemes:${theme.id}`,
      kind: 'terminalThemes',
      title: theme.label,
      detail: withMode(
        translate(
          'auto.components.settings.PluginDetailSections.typeTerminalTheme',
          'Terminal theme'
        ),
        theme.mode
      ),
      tone: 'default'
    })
  }
  for (const theme of source.iconThemes) {
    rows.push({
      key: `iconThemes:${theme.id}`,
      kind: 'iconThemes',
      title: theme.label,
      detail: translate(
        'auto.components.settings.PluginDetailSections.typeIconTheme',
        'File icon theme'
      ),
      tone: 'default'
    })
  }
  for (const syntax of source.syntaxes) {
    const files = fileList(syntax.extensions, syntax.filenames)
    const label = translate(
      'auto.components.settings.PluginDetailSections.typeSyntax',
      'Syntax highlighting'
    )
    rows.push({
      key: `syntaxes:${syntax.id}`,
      kind: 'syntaxes',
      title: syntax.label,
      detail: syntax.failed
        ? translate(
            'auto.components.settings.PluginSettingsRow.syntaxFailed',
            'Highlighting stopped: this grammar failed.'
          )
        : files
          ? `${label} · ${files}`
          : label,
      tone: syntax.failed ? 'destructive' : 'default'
    })
  }
  for (const language of source.languagePacks) {
    rows.push({
      key: `languagePacks:${language.locale}`,
      kind: 'languagePacks',
      title: languageDisplayName(language.locale),
      ...languageDetail(language.coverage)
    })
  }
  for (const [index, title] of source.panels.entries()) {
    rows.push({
      key: `panels:${index}`,
      kind: 'panels',
      title,
      detail: translate('auto.components.settings.PluginDetailSections.panel', 'Sidebar panel'),
      tone: 'default'
    })
  }
  for (const [index, editor] of source.customEditors.entries()) {
    const label = translate('auto.components.settings.PluginDetailSections.customEditor', 'Editor')
    const files = fileList(editor.extensions, editor.filenames)
    rows.push({
      key: `customEditors:${index}`,
      kind: 'customEditors',
      title: editor.title,
      detail: files ? `${label} · ${files}` : label,
      tone: 'default'
    })
  }
  for (const [index, newFile] of source.newFiles.entries()) {
    // Why no name: the row title is the menu item itself, so title and detail read as one line.
    const label = translate(
      'auto.components.settings.pluginContributions.newFileMenu',
      'Adds to the + menu'
    )
    rows.push({
      key: `newFiles:${index}`,
      kind: 'newFiles',
      title: newFile.title,
      detail: newFile.extension ? `${label} · ${newFile.extension}` : label,
      tone: 'default'
    })
  }
  for (const [index, title] of source.vmRecipes.entries()) {
    rows.push({
      key: `vmRecipes:${index}`,
      kind: 'vmRecipes',
      title,
      detail: translate('auto.components.settings.PluginDetailSections.recipe', 'Machine recipe'),
      tone: 'default'
    })
  }
  return rows
}

/** Catalog types no named row (or command) covers, e.g. a disabled plugin's theme. */
export function uncoveredCatalogTypes(
  types: readonly PluginCatalogType[],
  rows: readonly PluginContribution[],
  hasCommands: boolean
): PluginCatalogType[] {
  const covered = new Set<PluginCatalogType>(
    rows.flatMap((row) => PLUGIN_CONTRIBUTION_POINT_POLICY[row.kind].catalogType ?? [])
  )
  if (hasCommands) {
    covered.add('instructions')
  }
  // Why: background code isn't something it adds; access covers it.
  return types.filter((type) => type !== 'worker' && !covered.has(type))
}
