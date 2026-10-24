import type { PluginCatalogType } from '../../../../shared/plugins/plugin-catalog-release'
import { PLUGIN_LANGUAGE_PACK_MIN_COVERAGE } from '../../../../shared/plugins/plugin-language-pack-coverage'
import type { PluginManifest } from '../../../../shared/plugins/plugin-manifest'
import { translate } from '@/i18n/i18n'

export type PluginContributionKind =
  | 'app-theme'
  | 'terminal-theme'
  | 'icon-theme'
  | 'syntax'
  | 'language'
  | 'panel'
  | 'recipe'
  | 'agent'

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
  appThemes: readonly { id: string; label: string; base?: 'light' | 'dark' }[]
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
  languages: readonly { locale: string; coverage?: number }[]
  panels: readonly string[]
  recipes: readonly string[]
  agents: readonly string[]
}

export const EMPTY_CONTRIBUTION_SOURCE: PluginContributionSource = {
  appThemes: [],
  terminalThemes: [],
  iconThemes: [],
  syntaxes: [],
  languages: [],
  panels: [],
  recipes: [],
  agents: []
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
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(locale) ?? locale
  } catch {
    return locale
  }
}

export function manifestContributionSource(manifest: PluginManifest): PluginContributionSource {
  const { contributes } = manifest
  return {
    appThemes: contributes.themes,
    terminalThemes: contributes.terminalThemes,
    iconThemes: contributes.iconThemes,
    syntaxes: contributes.syntaxes,
    languages: contributes.languagePacks,
    panels: contributes.panels.map((panel) => panel.title),
    recipes: contributes.vmRecipes.map((recipe) => nameFromContributionPath(recipe.path)),
    agents: contributes.agents.map((agent) => nameFromContributionPath(agent.path))
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
  for (const theme of source.appThemes) {
    rows.push({
      key: `app-theme:${theme.id}`,
      kind: 'app-theme',
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
      key: `terminal-theme:${theme.id}`,
      kind: 'terminal-theme',
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
      key: `icon-theme:${theme.id}`,
      kind: 'icon-theme',
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
      key: `syntax:${syntax.id}`,
      kind: 'syntax',
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
  for (const language of source.languages) {
    rows.push({
      key: `language:${language.locale}`,
      kind: 'language',
      title: languageDisplayName(language.locale),
      ...languageDetail(language.coverage)
    })
  }
  for (const [index, title] of source.panels.entries()) {
    rows.push({
      key: `panel:${index}`,
      kind: 'panel',
      title,
      detail: translate('auto.components.settings.PluginDetailSections.panel', 'Sidebar panel'),
      tone: 'default'
    })
  }
  for (const [index, title] of source.recipes.entries()) {
    rows.push({
      key: `recipe:${index}`,
      kind: 'recipe',
      title,
      detail: translate('auto.components.settings.PluginDetailSections.recipe', 'Machine recipe'),
      tone: 'default'
    })
  }
  for (const [index, title] of source.agents.entries()) {
    rows.push({
      key: `agent:${index}`,
      kind: 'agent',
      title,
      detail: translate('auto.components.settings.pluginContributions.agent', 'Agent profile'),
      tone: 'default'
    })
  }
  return rows
}

const KIND_TYPE: Record<PluginContributionKind, PluginCatalogType> = {
  'app-theme': 'app-theme',
  'terminal-theme': 'terminal-theme',
  'icon-theme': 'icon-theme',
  syntax: 'syntax',
  language: 'interface-language',
  panel: 'panel',
  recipe: 'instructions',
  agent: 'instructions'
}

/** Catalog types no named row (or command) covers, e.g. a disabled plugin's theme. */
export function uncoveredCatalogTypes(
  types: readonly PluginCatalogType[],
  rows: readonly PluginContribution[],
  hasCommands: boolean
): PluginCatalogType[] {
  const covered = new Set<PluginCatalogType>(rows.map((row) => KIND_TYPE[row.kind]))
  if (hasCommands) {
    covered.add('instructions')
  }
  // Why: background code isn't something it adds; access covers it.
  return types.filter((type) => type !== 'worker' && !covered.has(type))
}
