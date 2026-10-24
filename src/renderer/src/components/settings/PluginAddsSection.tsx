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
} from '../../../../preload/api-types'
import { formatKeybinding } from '../../../../shared/keybindings/formatting'
import type { PluginCatalogType } from '../../../../shared/plugins/plugin-catalog-release'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { Button } from '../ui/button'
import { DetailRow, DetailSection } from './PluginDetailSections'
import { shadowedKeybindingTitles } from './PluginKeybindingConsentPreview'
import {
  describePluginContributions,
  EMPTY_CONTRIBUTION_SOURCE,
  manifestContributionSource,
  uncoveredCatalogTypes,
  type PluginContributionKind
} from './plugin-contributions'
import { useInstalledPluginContributions } from './use-plugin-contribution-source'

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
}

function CommandRow({
  command,
  onOpenShortcuts
}: {
  command: AddsCommand
  onOpenShortcuts: () => void
}): React.JSX.Element {
  const overrides = useAppStore((state) => state.keybindings)
  const platform = shortcutPlatform()
  const binding = command.keybindings[0]
  const shadowed = binding ? shadowedKeybindingTitles(binding.key, platform, overrides) : []
  return (
    <DetailRow
      icon={<Command />}
      title={command.title}
      detailTone={shadowed.length > 0 ? 'warning' : 'default'}
      detail={
        shadowed.length > 0 ? (
          <>
            {translate(
              'auto.components.settings.PluginDetailSections.replaces',
              'Replaces your shortcut for {{value0}}',
              { value0: shadowed.join(', ') }
            )}
            {' · '}
            <Button variant="link" size="xs" onClick={onOpenShortcuts}>
              {translate(
                'auto.components.settings.PluginDetailSections.changeShortcuts',
                'Change in Shortcuts'
              )}
            </Button>
          </>
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
        binding ? <ShortcutKeyCombo keys={formatKeybinding(binding.key, platform)} /> : null
      }
    />
  )
}

/**
 * Each named thing the plugin adds. An installed plugin reads Orca's live registrations, or its
 * manifest while it's off or under review; a catalog plugin reads its fetched manifest. Catalog
 * types fill in whatever neither names (a manifest that couldn't be read).
 */
export function PluginAddsSection({
  plugin,
  preview,
  types,
  onOpenShortcuts
}: {
  plugin: PluginHostListEntry | null
  preview: PluginMarketplaceHostInstallPreview | null
  types: readonly PluginCatalogType[]
  onOpenShortcuts: () => void
}): React.JSX.Element | null {
  const installedSource = useInstalledPluginContributions(plugin)
  const source = plugin
    ? installedSource
    : preview
      ? manifestContributionSource(preview.manifest)
      : EMPTY_CONTRIBUTION_SOURCE
  const commands: AddsCommand[] =
    plugin?.commands ??
    preview?.manifest.contributes.commands.map((command) => ({
      id: command.id,
      title: command.title,
      keybindings: preview.manifest.contributes.keybindings
        .filter((binding) => binding.command === command.id)
        .map((binding) => ({ key: binding.key, when: binding.when ?? 'global' }))
    })) ??
    []
  const rows = describePluginContributions(source)
  // Why: a fetched manifest is exact, so its types add nothing.
  const fallbackTypes =
    preview && !plugin ? [] : uncoveredCatalogTypes(types, rows, commands.length > 0)
  const total = rows.length + commands.length + fallbackTypes.length
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
        />
      ))}
      {commands.map((command) => (
        <CommandRow key={command.id} command={command} onOpenShortcuts={onOpenShortcuts} />
      ))}
      {fallbackTypes.map((type) => (
        <DetailRow key={type} icon={<FileCode />} title={catalogTypeLabel(type)} />
      ))}
    </DetailSection>
  )
}
