import {
  Blocks,
  Bot,
  Command,
  FileCode,
  Highlighter,
  Languages,
  Palette,
  PanelRight,
  Server,
  SquareTerminal
} from 'lucide-react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview
} from '../../../../../preload/api-types'
import { formatKeybinding } from '../../../../../shared/keybindings/formatting'
import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { usePluginSyntaxes } from '@/store/plugin-syntax-packs'
import { ShortcutKeyCombo } from '../../ShortcutKeyCombo'
import { DetailRow, DetailSection } from './PluginDetailSections'
import { PluginContributionActionCommand } from './PluginContributionActionCommand'
import { PluginContributionEventRow, usePluginWorkerEvents } from './PluginContributionActionEvents'
import { PluginContributionActionLanguage } from './PluginContributionActionLanguage'
import { PluginContributionActionPanel } from './PluginContributionActionPanel'
import { PluginContributionSyntaxHint } from './PluginContributionActionSyntax'
import {
  isPluginContributionLive,
  pluginCommandUnavailableReason
} from './plugin-contribution-action-availability'
import { shadowedKeybindingTitles } from '../presentation/plugin-keybinding-conflicts'
import type { PluginContributionSummaryItem } from '../../../../../shared/plugins/plugin-contribution-summary'
import {
  describePluginContributions,
  summaryContributionSource,
  EMPTY_CONTRIBUTION_SOURCE,
  manifestContributionSource,
  uncoveredCatalogTypes,
  type PluginContribution,
  type PluginContributionKind
} from '../presentation/plugin-contributions'
import { useInstalledPluginContributions } from '../state/use-plugin-contribution-source'

function shortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  return navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
}

function catalogTypeLabel(type: PluginCatalogType): string {
  switch (type) {
    case 'interface-language':
      return translate(
        'auto.components.settings.PluginDetailSections.typeLanguagePack',
        'Interface language'
      )
    case 'app-theme':
      return translate('auto.components.settings.PluginDetailSections.typeAppTheme', 'App theme')
    case 'terminal-theme':
      return translate(
        'auto.components.settings.PluginDetailSections.typeTerminalTheme',
        'Terminal theme'
      )
    case 'icon-theme':
      return translate(
        'auto.components.settings.PluginDetailSections.typeIconTheme',
        'File icon theme'
      )
    case 'syntax':
      return translate(
        'auto.components.settings.PluginDetailSections.typeSyntax',
        'Syntax highlighting'
      )
    case 'instructions':
      return translate(
        'auto.components.settings.PluginDetailSections.typeInstructions',
        'Agent instructions'
      )
    case 'panel':
      return translate('auto.components.settings.PluginDetailSections.typePanel', 'Sidebar panel')
    case 'worker':
      return translate(
        'auto.components.settings.PluginDetailSections.typeWorker',
        'Background code'
      )
  }
}

const CONTRIBUTION_ICON: Record<PluginContributionKind, React.ReactNode> = {
  'app-theme': <Palette />,
  'terminal-theme': <SquareTerminal />,
  'icon-theme': <Blocks />,
  syntax: <Highlighter />,
  language: <Languages />,
  panel: <PanelRight />,
  recipe: <Server />,
  agent: <Bot />
}

type AddsCommand = {
  id: string
  title: string
  keybindings: readonly { key: string; when: 'global' | 'worktree' }[]
  /** Set once the plugin is on, so the row can run it exactly as the palette would. */
  live?: ActivePluginCommand
}

function CommandRow({
  command,
  onOpenShortcuts
}: {
  command: AddsCommand
  onOpenShortcuts: () => void
}): React.JSX.Element {
  const overrides = useAppStore((state) => state.keybindings)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const platform = shortcutPlatform()
  const binding = command.keybindings[0]
  const shadowed = binding ? shadowedKeybindingTitles(binding.key, platform, overrides) : []
  const unavailableReason = command.live
    ? pluginCommandUnavailableReason(command.live, activeWorktreeId)
    : null
  return (
    <DetailRow
      icon={<Command />}
      title={command.title}
      detailTone={shadowed.length > 0 ? 'warning' : 'default'}
      detail={
        shadowed.length > 0 ? (
          <span className="flex flex-col items-start">
            {translate(
              'auto.components.settings.PluginDetailSections.replaces',
              'Replaces your shortcut for {{value0}}',
              { value0: shadowed.join(', ') }
            )}
            <button
              type="button"
              className="mt-0.5 rounded-sm text-xs text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenShortcuts}
            >
              {translate(
                'auto.components.settings.PluginDetailSections.changeShortcuts',
                'Change in Shortcuts'
              )}
            </button>
          </span>
        ) : unavailableReason ? (
          unavailableReason
        ) : binding?.when === 'worktree' ? (
          translate(
            'auto.components.settings.PluginKeybindingConsentPreview.worktree',
            'Runs only while a workspace is active.'
          )
        ) : (
          translate('auto.components.settings.PluginDetailSections.command', 'Command')
        )
      }
      trailing={
        binding || command.live ? (
          <span className="flex items-center gap-2">
            {binding ? <ShortcutKeyCombo keys={formatKeybinding(binding.key, platform)} /> : null}
            {command.live ? (
              <PluginContributionActionCommand
                command={command.live}
                unavailableReason={unavailableReason}
              />
            ) : null}
          </span>
        ) : null
      }
    />
  )
}

/** The id a row's key carries after its kind, e.g. a syntax id, a locale or a panel index. */
function contributionRowId(row: PluginContribution): string {
  return row.key.slice(row.kind.length + 1)
}

/**
 * The "try it" control for a row, only while the plugin is on and Orca's live registration
 * (not the manifest) backs it, so the control never promises something that isn't there.
 */
function useContributionRowActions(
  plugin: PluginHostListEntry | null
): (row: PluginContribution) => React.ReactNode {
  const syntaxes = usePluginSyntaxes()
  const languagePacks = usePluginLanguagePackStore((state) => state.entries)
  if (!isPluginContributionLive(plugin)) {
    return () => null
  }
  return (row) => {
    const id = contributionRowId(row)
    switch (row.kind) {
      case 'syntax': {
        const syntax = syntaxes.find(
          (entry) => entry.id === id && entry.pluginKey === plugin.pluginKey
        )
        return syntax && row.tone !== 'destructive' ? (
          <PluginContributionSyntaxHint
            extensions={syntax.extensions}
            filenames={syntax.filenames}
          />
        ) : null
      }
      case 'language': {
        const pack = languagePacks.find(
          (entry) => entry.locale === id && entry.pluginKey === plugin.pluginKey
        )
        return pack ? <PluginContributionActionLanguage pack={pack} /> : null
      }
      case 'panel': {
        const panel = plugin.panels[Number(id)]
        return panel ? <PluginContributionActionPanel panel={panel} /> : null
      }
      case 'app-theme':
      case 'terminal-theme':
      case 'icon-theme':
      case 'agent':
      case 'recipe':
        // Themes have "Use now" above the list; agents and recipes have nothing to try here.
        return null
    }
  }
}

/**
 * Each named thing the plugin adds. An installed plugin reads Orca's live registrations, or its
 * manifest while it's off or under review; a catalog plugin reads its fetched manifest. Catalog
 * types fill in whatever neither names (a manifest that couldn't be read).
 */
export function PluginAddsSection({
  plugin,
  preview,
  summary,
  themePreview,
  types,
  onOpenShortcuts
}: {
  plugin: PluginHostListEntry | null
  preview: PluginMarketplaceHostInstallPreview | null
  /** The catalog's summary, checked against the manifest at install; paints before preview. */
  summary: readonly PluginContributionSummaryItem[] | undefined
  themePreview: readonly { label: string; base: 'light' | 'dark' }[] | undefined
  types: readonly PluginCatalogType[]
  onOpenShortcuts: () => void
}): React.JSX.Element | null {
  const installedSource = useInstalledPluginContributions(plugin)
  // Why the summary over the preview: same names, known at first paint, so rows never appear late.
  const source = plugin
    ? installedSource
    : summary
      ? summaryContributionSource(summary, themePreview)
      : preview
        ? manifestContributionSource(preview.manifest)
        : EMPTY_CONTRIBUTION_SOURCE
  const previewCommands = preview?.manifest.contributes.commands.map((command) => ({
    id: command.id,
    title: command.title,
    keybindings: preview.manifest.contributes.keybindings
      .filter((binding) => binding.command === command.id)
      .map((binding) => ({ key: binding.key, when: binding.when ?? 'global' }))
  }))
  const rowAction = useContributionRowActions(plugin)
  const events = usePluginWorkerEvents(plugin)
  const commands: AddsCommand[] =
    plugin?.commands.map((command) =>
      isPluginContributionLive(plugin)
        ? { ...command, live: { ...command, pluginKey: plugin.pluginKey, pluginName: plugin.name } }
        : command
    ) ??
    (summary
      ? summary
          .filter((item) => item.kind === 'commands')
          .map(
            (item, index) =>
              // Why by position: the summary lists commands in manifest order, without ids.
              previewCommands?.[index] ?? {
                id: `summary-${index}`,
                title: item.name,
                keybindings: []
              }
          )
      : previewCommands) ??
    []
  const rows = describePluginContributions(source)
  // Why: a fetched manifest or a catalog summary is exact, so its types add nothing.
  const fallbackTypes =
    (preview || summary) && !plugin ? [] : uncoveredCatalogTypes(types, rows, commands.length > 0)
  const total = rows.length + commands.length + events.length + fallbackTypes.length
  if (total === 0) {
    return null
  }
  return (
    <DetailSection
      title={translate('auto.components.settings.PluginDetailSections.adds', 'Adds to Orca')}
      count={String(total)}
    >
      {rows.map((row) => (
        <DetailRow
          key={row.key}
          icon={CONTRIBUTION_ICON[row.kind]}
          title={row.title}
          detail={row.detail}
          detailTone={row.tone}
          trailing={rowAction(row)}
        />
      ))}
      {commands.map((command) => (
        <CommandRow key={command.id} command={command} onOpenShortcuts={onOpenShortcuts} />
      ))}
      {events.map((event) => (
        <PluginContributionEventRow key={`event:${event}`} event={event} />
      ))}
      {fallbackTypes.map((type) => (
        <DetailRow key={type} icon={<FileCode />} title={catalogTypeLabel(type)} />
      ))}
    </DetailSection>
  )
}
