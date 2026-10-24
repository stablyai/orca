import {
  Command,
  Cpu,
  FileCode,
  Highlighter,
  Languages,
  Palette,
  PanelRight,
  Puzzle,
  SquareTerminal
} from 'lucide-react'
import type { PluginCatalogType } from '../../../../shared/plugins/plugin-catalog-release'
import type { PluginListEntry } from './plugin-list-entries'

const TYPE_ICON: Record<PluginCatalogType, typeof Palette> = {
  'app-theme': Palette,
  'terminal-theme': SquareTerminal,
  'icon-theme': FileCode,
  syntax: Highlighter,
  'interface-language': Languages,
  instructions: Command,
  panel: PanelRight,
  worker: Cpu
}

// Why the broadest first: the tile should name the thing that matters most for trust.
const TYPE_ORDER: readonly PluginCatalogType[] = [
  'worker',
  'panel',
  'instructions',
  'app-theme',
  'terminal-theme',
  'icon-theme',
  'syntax',
  'interface-language'
]

/** What a plugin is, from its catalog types plus what an installed copy shows it carries. */
export function pluginArtTypes(entry: PluginListEntry): PluginCatalogType[] {
  const installed = entry.installed
  const types: PluginCatalogType[] = [...entry.types]
  if (installed?.hasWorker) {
    types.push('worker')
  }
  if (installed && installed.panels.length > 0) {
    types.push('panel')
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
