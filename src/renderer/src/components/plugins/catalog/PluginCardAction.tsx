import { Check, Ellipsis, Loader2, Power, Trash2 } from 'lucide-react'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { StatusWord } from '../list/PluginStatusWord'
import type { PluginListEntry } from '../list/plugin-list-entries'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { installedPluginPresentation } from '../presentation/plugin-status-presentation'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import type { PluginInstallPhase } from '../state/use-plugin-install-action'

export function needsNewerOrca(entry: PluginListEntry, orcaVersion: string | null): string | null {
  return entry.minimumOrca &&
    orcaVersion &&
    !satisfiesOrcaEngineRange(orcaVersion, `>=${entry.minimumOrca}`)
    ? entry.minimumOrca
    : null
}

/** One click installs only what the catalog verifies as content only; anything else is reviewed. */
export function installsInOneClick(entry: PluginListEntry): boolean {
  return entry.listing?.release?.execution === 'data'
}

/** Compact installed actions; removal uses the shared confirmation. */
function InstalledCardMenu({
  entry,
  busy,
  onRemove,
  onToggleEnabled
}: {
  entry: PluginListEntry
  busy: boolean
  onRemove: () => void
  onToggleEnabled: () => void
}): React.JSX.Element | null {
  const installed = entry.installed
  if (!installed) {
    return null
  }
  const { removable, switchable, enabled } = installedPluginPresentation(
    installed,
    entry.updateVersion,
    busy
  )
  if (!removable && !switchable) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          aria-label={translate(
            'auto.components.settings.PluginCardAction.moreLabel',
            'More actions for {{value0}}',
            { value0: entry.name }
          )}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {switchable ? (
          <DropdownMenuItem onSelect={onToggleEnabled}>
            <Power />
            {enabled
              ? translate('auto.components.settings.PluginCardAction.disable', 'Disable')
              : translate('auto.components.settings.PluginCardAction.enable', 'Enable')}
          </DropdownMenuItem>
        ) : null}
        {removable ? (
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 />
            {translate('auto.components.settings.PluginCardAction.remove', 'Remove')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What a catalog card's single action slot offers, by state. */
export function PluginCardAction({
  entry,
  phase,
  orcaVersion,
  onInstall,
  onOpen,
  onRemove,
  onToggleEnabled,
  installedHandlers,
  onOpenFullAccessSetting,
  busy = false,
  refreshing = false
}: {
  entry: PluginListEntry
  refreshing?: boolean
  /** Set when installing needs the full access setting turned on first. */
  onOpenFullAccessSetting?: () => void
  phase: PluginInstallPhase | null
  orcaVersion: string | null
  onInstall: () => void
  onOpen: () => void
  onRemove: () => void
  onToggleEnabled: () => void
  installedHandlers: InstalledRowHandlers
  /** A remove or switch for this plugin is in flight. */
  busy?: boolean
}): React.JSX.Element | null {
  const installed = entry.installed
  if (installed) {
    const controls = installedPluginControls(installed, entry, {
      busy,
      canCheckUpdate: entry.updatable,
      handlers: installedHandlers
    })
    const status = controls.action ?? (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3.5" aria-hidden="true" />
        {translate('auto.components.settings.PluginCardAction.installed', 'Installed')}
      </span>
    )
    return (
      <>
        {status}
        <InstalledCardMenu
          entry={entry}
          busy={busy}
          onRemove={onRemove}
          onToggleEnabled={onToggleEnabled}
        />
      </>
    )
  }
  if (entry.listing?.blockedByKillList) {
    return <StatusWord kind="blocked" />
  }
  const needsOrca = needsNewerOrca(entry, orcaVersion)
  if (needsOrca) {
    return (
      <span className="text-xs whitespace-nowrap text-status-warning-text">
        {translate(
          'auto.components.settings.PluginManagerRows.needsOrca',
          'Needs Orca {{value0}}',
          {
            value0: needsOrca
          }
        )}
      </span>
    )
  }
  if (onOpenFullAccessSetting) {
    return (
      <Button variant="outline" size="xs" className="w-32" onClick={onOpenFullAccessSetting}>
        {translate(
          'auto.components.settings.PluginCardAction.openFullAccess',
          'Turn on in settings'
        )}
      </Button>
    )
  }
  if (phase?.kind === 'installing') {
    return (
      <Button variant="outline" size="xs" className="w-32" disabled>
        <Loader2 className="animate-spin" />
        {translate('auto.components.settings.PluginCardAction.installing', 'Installing…')}
      </Button>
    )
  }
  if (!installsInOneClick(entry)) {
    return (
      <Button
        variant="outline"
        size="xs"
        className="w-32"
        aria-label={translate(
          'auto.components.settings.PluginCardAction.reviewLabel',
          'Review and install {{value0}}',
          { value0: entry.name }
        )}
        onClick={onOpen}
      >
        {translate('auto.components.settings.PluginCardAction.review', 'Review & install')}
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="xs"
      className="w-32"
      disabled={refreshing}
      aria-label={translate(
        'auto.components.settings.PluginManagerRows.installName',
        'Install {{value0}}',
        { value0: entry.name }
      )}
      onClick={onInstall}
    >
      {phase?.kind === 'error'
        ? translate('auto.components.settings.PluginCardAction.retry', 'Try again')
        : translate('auto.components.settings.PluginMarketplaceListingRow.install', 'Install')}
    </Button>
  )
}
