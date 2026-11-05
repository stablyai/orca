import {
  Command,
  Cpu,
  FileCode,
  Highlighter,
  Languages,
  Palette,
  PanelRight,
  PenTool,
  Puzzle,
  SquareTerminal
} from 'lucide-react'
import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import type { PluginListEntry } from './plugin-list-entries'

const TYPE_ICON: Record<PluginCatalogType, typeof Palette> = {
  'app-theme': Palette,
  'terminal-theme': SquareTerminal,
  'icon-theme': FileCode,
  syntax: Highlighter,
  'interface-language': Languages,
  instructions: Command,
  panel: PanelRight,
  editor: PenTool,
  worker: Cpu
}

// Why the broadest first: the tile should name the thing that matters most for trust.
const TYPE_ORDER: readonly PluginCatalogType[] = [
  'worker',
  'panel',
  'editor',
  'instructions',
  'app-theme',
  'terminal-theme',
  'icon-theme',
  'syntax',
  'interface-language'
]

// Why: format 1 catalogs list no types, only categories; art still shows what the plugin is.
const ART_TYPE_BY_CATEGORY: Readonly<Record<string, PluginCatalogType>> = {
  themes: 'app-theme',
  'app-themes': 'app-theme',
  'terminal-themes': 'terminal-theme',
  icons: 'icon-theme',
  'icon-themes': 'icon-theme',
  syntax: 'syntax',
  syntaxes: 'syntax',
  languages: 'syntax',
  'language-packs': 'interface-language',
  localization: 'interface-language',
  keybindings: 'instructions',
  commands: 'instructions',
  'vm-recipes': 'instructions',
  recipes: 'instructions',
  machines: 'instructions',
  panels: 'panel',
  editors: 'editor'
}

/** What a plugin is, from its catalog types plus what an installed copy shows it carries. */
export function pluginArtTypes(entry: PluginListEntry): PluginCatalogType[] {
  const installed = entry.installed
  const types: PluginCatalogType[] =
    entry.types.length > 0
      ? [...entry.types]
      : entry.categories.flatMap((category) => ART_TYPE_BY_CATEGORY[category] ?? [])
  if (installed?.hasWorker) {
    types.push('worker')
  }
  if (installed && installed.panels.length > 0) {
    types.push('panel')
  }
  if (installed && (installed.customEditors?.length ?? 0) > 0) {
    types.push('editor')
  }
  if (installed && installed.commands.length > 0) {
    types.push('instructions')
  }
  return types
}

function rowType(entry: PluginListEntry): PluginCatalogType | null {
  const types = pluginArtTypes(entry)
  return TYPE_ORDER.find((type) => types.includes(type)) ?? null
}

/** A row's small picture: what kind of plugin it is, never initials beside a status switch. */
export function PluginRowArt({ entry }: { entry: PluginListEntry }): React.JSX.Element {
  const type = rowType(entry)
  const Icon = type ? TYPE_ICON[type] : Puzzle
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted text-muted-foreground"
    >
      <Icon className="size-4" />
    </div>
  )
}

/** The first shortcut a plugin binds, for keycap art: the catalog's summary, else its install. */
export function pluginArtShortcut(entry: PluginListEntry): string | null {
  const fromCatalog = entry.listing?.release?.contributes?.find(
    (item) => item.kind === 'keybindings'
  )?.name
  const fromInstall = entry.installed?.commands.flatMap((command) => command.keybindings)[0]?.key
  return fromCatalog ?? fromInstall ?? null
}
