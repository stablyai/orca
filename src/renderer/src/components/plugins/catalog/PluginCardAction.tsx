import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { StatusWord } from '../list/PluginStatusWord'
import { needsNewerOrca, type PluginListEntry } from '../list/plugin-list-entries'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import type { PluginInstallPhase } from '../state/use-plugin-install-action'
import { usePluginInUse } from '../state/use-plugin-in-use'
import { PluginInUseAction } from './PluginInUseAction'

/** The Install button's words for a catalog plugin's install phase. */
export function installButtonLabel(phase: PluginInstallPhase | null): string {
  return phase?.kind === 'installing'
    ? translate('auto.components.settings.PluginCardAction.installing', 'Installing…')
    : phase?.kind === 'error'
      ? translate('auto.components.settings.PluginCardAction.retry', 'Try again')
      : translate('auto.components.settings.PluginMarketplaceListingRow.install', 'Install')
}

/** One click installs only what the catalog verifies as content only; anything else is reviewed. */
function installsInOneClick(entry: PluginListEntry): boolean {
  return entry.listing?.release?.execution === 'data'
}

/** What a catalog card's single action slot offers, by state. */
export function PluginCardAction({
  entry,
  phase,
  orcaVersion,
  onInstall,
  onOpen,
  installedHandlers,
  busy = false,
  refreshing = false
}: {
  entry: PluginListEntry
  refreshing?: boolean
  phase: PluginInstallPhase | null
  orcaVersion: string | null
  onInstall: () => void
  onOpen: () => void
  installedHandlers: InstalledRowHandlers
  /** A remove or switch for this plugin is in flight. */
  busy?: boolean
}): React.JSX.Element | null {
  const installed = entry.installed
  const inUse = usePluginInUse(installed ? entry.pluginKey : null)
  if (installed) {
    const controls = installedPluginControls(installed, entry, {
      busy,
      canCheckUpdate: entry.updatable,
      handlers: installedHandlers
    })
    const switchable =
      controls.kind !== 'review' && controls.kind !== 'invalid' && controls.kind !== 'blocked'
    const healthy = controls.kind === 'enabled' || controls.kind === 'running'
    // Why no word for on/off: the switch beside it already says it.
    const status =
      controls.action ??
      (healthy ? (
        inUse ? (
          <PluginInUseAction pluginKey={entry.pluginKey} name={entry.name} inUse={inUse} />
        ) : null
      ) : controls.kind === 'disabled' ? null : (
        controls.status
      ))
    return (
      <>
        {status}
        {switchable ? controls.toggle : null}
        {controls.more}
      </>
    )
  }
  if (entry.listing?.blockedByKillList) {
    return <StatusWord kind="blocked" />
  }
  const needsOrca = needsNewerOrca(entry.minimumOrca, orcaVersion)
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
  if (phase?.kind === 'installing') {
    return (
      <Button variant="outline" size="xs" className="w-32" disabled>
        <Loader2 className="animate-spin" />
        {installButtonLabel(phase)}
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
      {installButtonLabel(phase)}
    </Button>
  )
}
