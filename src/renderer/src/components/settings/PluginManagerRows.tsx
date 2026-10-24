import { ArrowUpCircle, Copy, FileText, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu'
import { PluginListRow } from '../plugin-catalog/PluginListRow'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import { SettingsSwitch } from './SettingsFormControls'
import {
  isPluginEnabled,
  pluginNeedsReview,
  pluginStatusKind,
  type PluginStatusKind
} from './plugin-status-presentation'
import { invalidPluginErrorMessage } from './plugin-error-presentation'
import { usePluginRollbackVersion } from './use-plugin-rollback-version'
import { satisfiesOrcaEngineRange } from '../../../../shared/plugins/plugin-manifest'
import { copyPluginId, DetailsItem, MoreButton } from './PluginRowMenu'
import { PluginChips } from '../plugin-catalog/PluginChips'
import { StatusWord, statusWordFor } from '../plugin-catalog/PluginStatusWord'

export type InstalledRowHandlers = {
  onOpen: (pluginKey: string) => void
  onReview: (pluginKey: string) => void
  onToggleEnabled: (pluginKey: string) => void
  onRestart: (pluginKey: string) => void
  onViewLogs: (pluginKey: string) => void
  onCheckUpdate: (entry: PluginListEntry) => void
  onRollbackRequest: (pluginKey: string) => void
  onRemoveRequest: (pluginKey: string) => void
}

export type InstalledPluginControls = {
  kind: PluginStatusKind
  statusText: string
  description: React.ReactNode
  tone: 'default' | 'destructive'
  status: React.ReactNode
  action: React.ReactNode
  toggle: React.ReactNode
  more: React.ReactNode
}

/** What an installed plugin shows and offers, shared by its row and its page. */
export function installedPluginControls(
  plugin: PluginHostListEntry,
  entry: PluginListEntry,
  {
    busy,
    canCheckUpdate,
    handlers,
    inPage = false
  }: {
    busy: boolean
    canCheckUpdate: boolean
    handlers: InstalledRowHandlers
    /** On the plugin's own page, so "Details" would reopen it. */
    inPage?: boolean
  }
): InstalledPluginControls {
  const kind = pluginStatusKind(plugin)
  const needsReview = pluginNeedsReview(plugin)
  const enabled = isPluginEnabled(plugin)
  const statusText = entry.updateVersion
    ? `${statusWordFor(kind)}, ${translate(
        'auto.components.settings.PluginManagerRows.updateAvailable',
        'update {{value0}} available',
        { value0: entry.updateVersion }
      )}`
    : statusWordFor(kind)
  const removable = !plugin.bundled && !plugin.isDev

  let description: React.ReactNode = entry.description ?? ''
  let tone: 'default' | 'destructive' = 'default'
  if (plugin.blockedByKillList) {
    tone = 'destructive'
    description = translate(
      'auto.components.settings.PluginSettingsRow.killListMessage',
      "Orca's safety list disabled this plugin: {{value0}}",
      { value0: plugin.blockedByKillList.reason }
    )
  } else if (kind === 'invalid' && plugin.error) {
    tone = 'destructive'
    description = invalidPluginErrorMessage(plugin.error)
  } else if (kind === 'error') {
    tone = 'destructive'
    description =
      plugin.restarts === 1
        ? translate(
            'auto.components.settings.PluginManagerRows.crashedOnce',
            'Crashed once. View its logs on the plugin page.'
          )
        : plugin.restarts > 1
          ? translate(
              'auto.components.settings.PluginManagerRows.crashedCount',
              'Crashed {{value0}} times in a row. View its logs on the plugin page.',
              { value0: plugin.restarts }
            )
          : translate(
              'auto.components.settings.PluginManagerRows.crashed',
              'Crashed while starting. View its logs on the plugin page.'
            )
  }

  let action: React.ReactNode = null
  if (busy) {
    action = <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
  } else if (plugin.blockedByKillList && removable) {
    action = (
      <Button
        variant="outline"
        size="xs"
        onClick={() => handlers.onRemoveRequest(plugin.pluginKey)}
      >
        {translate('auto.components.settings.PluginManagerRows.remove', 'Remove…')}
      </Button>
    )
  } else if (needsReview) {
    action = (
      <Button size="xs" onClick={() => handlers.onReview(plugin.pluginKey)}>
        {translate('auto.components.settings.PluginManagerRows.review', 'Review')}
      </Button>
    )
  } else if (kind === 'error') {
    action = (
      <Button variant="outline" size="xs" onClick={() => handlers.onRestart(plugin.pluginKey)}>
        <RotateCcw />
        {translate('auto.components.settings.PluginManagerRows.restart', 'Restart')}
      </Button>
    )
  } else if (entry.updateVersion) {
    action = (
      <Button
        variant="outline"
        size="xs"
        aria-label={translate(
          'auto.components.settings.PluginManagerRows.updateLabel',
          'Update {{value0}} to {{value1}}',
          { value0: plugin.name, value1: entry.updateVersion }
        )}
        onClick={() => handlers.onCheckUpdate(entry)}
      >
        <ArrowUpCircle />
        {translate('auto.components.settings.PluginManagerRows.update', 'Update {{value0}}', {
          value0: entry.updateVersion
        })}
      </Button>
    )
  } else if (kind === 'invalid') {
    action = (
      <Button variant="outline" size="xs" onClick={() => handlers.onOpen(plugin.pluginKey)}>
        {translate('auto.components.settings.PluginManagerRows.viewError', 'View error')}
      </Button>
    )
  }

  const switchDisabled =
    busy || needsReview || kind === 'invalid' || Boolean(plugin.blockedByKillList)
  return {
    kind,
    statusText,
    description,
    tone,
    status: <StatusWord kind={kind} />,
    action,
    toggle: (
      <span className="relative inline-flex">
        <SettingsSwitch
          checked={enabled && !needsReview}
          disabled={switchDisabled}
          onChange={() => handlers.onToggleEnabled(plugin.pluginKey)}
          ariaLabel={
            enabled && !needsReview
              ? translate(
                  'auto.components.settings.PluginSettingsRow.disableLabel',
                  'Disable {{value0}}',
                  {
                    value0: plugin.name
                  }
                )
              : translate(
                  'auto.components.settings.PluginSettingsRow.enableLabel',
                  'Enable {{value0}}',
                  {
                    value0: plugin.name
                  }
                )
          }
        />
        {kind === 'error' ? (
          // Why: marks "on but stopped"; the status word says it in text.
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive ring-2 ring-card"
          />
        ) : null}
      </span>
    ),
    more: (
      <MoreButton name={plugin.name}>
        {inPage ? null : <DetailsItem onSelect={() => handlers.onOpen(plugin.pluginKey)} />}
        {plugin.hasWorker && !inPage ? (
          <DropdownMenuItem onSelect={() => handlers.onViewLogs(plugin.pluginKey)}>
            <FileText />
            {translate('auto.components.settings.PluginSettingsRow.viewLogs', 'View logs')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyPluginId(plugin.pluginKey)}>
          <Copy />
          {translate('auto.components.settings.PluginManagerRows.copyId', 'Copy plugin ID')}
        </DropdownMenuItem>
        {canCheckUpdate ? (
          <DropdownMenuItem onSelect={() => handlers.onCheckUpdate(entry)}>
            <ArrowUpCircle />
            {translate(
              'auto.components.settings.PluginManagerRows.checkUpdate',
              'Check for update'
            )}
          </DropdownMenuItem>
        ) : null}
        {plugin.source?.kind === 'marketplace' || removable || plugin.bundled ? (
          <DropdownMenuSeparator />
        ) : null}
        {plugin.source?.kind === 'marketplace' ? (
          <RollbackItem
            pluginKey={plugin.pluginKey}
            onSelect={() => handlers.onRollbackRequest(plugin.pluginKey)}
          />
        ) : null}
        {removable ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => handlers.onRemoveRequest(plugin.pluginKey)}
          >
            <Trash2 />
            {translate('auto.components.settings.PluginManagerRows.remove', 'Remove…')}
          </DropdownMenuItem>
        ) : plugin.bundled ? (
          <DropdownMenuItem disabled>
            <Trash2 />
            {translate(
              'auto.components.settings.PluginManagerRows.bundledWithOrca',
              'Bundled with Orca'
            )}
          </DropdownMenuItem>
        ) : null}
      </MoreButton>
    )
  }
}

// Why: menu content mounts on open, so the rollback version is read only when someone looks.
function RollbackItem({
  pluginKey,
  onSelect
}: {
  pluginKey: string
  onSelect: () => void
}): React.JSX.Element | null {
  const version = usePluginRollbackVersion(pluginKey)
  if (!version) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <RotateCcw />
      {translate(
        'auto.components.settings.PluginManagerRows.rollbackTo',
        'Roll back to {{value0}}…',
        {
          value0: version
        }
      )}
    </DropdownMenuItem>
  )
}

export function InstalledPluginRow({
  entry,
  busy,
  canCheckUpdate,
  handlers
}: {
  entry: PluginListEntry
  busy: boolean
  canCheckUpdate: boolean
  handlers: InstalledRowHandlers
}): React.JSX.Element | null {
  const plugin = entry.installed
  if (!plugin) {
    return null
  }
  const controls = installedPluginControls(plugin, entry, { busy, canCheckUpdate, handlers })
  return (
    <PluginListRow
      entry={entry}
      statusText={controls.statusText}
      description={controls.description}
      descriptionTone={controls.tone}
      chips={<PluginChips entry={entry} />}
      dimmed={controls.kind === 'disabled'}
      status={controls.status}
      action={controls.action}
      toggle={controls.toggle}
      more={controls.more}
      onOpen={() => handlers.onOpen(plugin.pluginKey)}
    />
  )
}

export function AvailablePluginRow({
  entry,
  busy,
  orcaVersion,
  onOpen,
  onInstall
}: {
  entry: PluginListEntry
  busy: boolean
  orcaVersion: string | null
  onOpen: (entry: PluginListEntry) => void
  onInstall: (entry: PluginListEntry) => void
}): React.JSX.Element {
  const blocked = entry.listing?.blockedByKillList
  const needsOrca =
    entry.minimumOrca &&
    orcaVersion &&
    !satisfiesOrcaEngineRange(orcaVersion, `>=${entry.minimumOrca}`)
      ? entry.minimumOrca
      : null
  const needsOrcaText = needsOrca
    ? translate('auto.components.settings.PluginManagerRows.needsOrca', 'Needs Orca {{value0}}', {
        value0: needsOrca
      })
    : null
  return (
    <PluginListRow
      entry={entry}
      statusText={
        blocked
          ? translate('auto.components.settings.PluginSettingsRow.blocked', 'Blocked')
          : undefined
      }
      description={
        blocked
          ? translate(
              'auto.components.settings.PluginMarketplaceListingRow.blocked',
              "Blocked by Orca's safety list: {{value0}}",
              { value0: blocked.reason }
            )
          : (entry.description ??
            translate(
              'auto.components.settings.PluginMarketplaceListingRow.noDescription',
              'No description provided.'
            ))
      }
      descriptionTone={blocked ? 'destructive' : 'default'}
      chips={<PluginChips entry={entry} />}
      status={
        blocked ? (
          <StatusWord kind="blocked" />
        ) : needsOrcaText ? (
          <span className="text-xs whitespace-nowrap text-status-warning">{needsOrcaText}</span>
        ) : null
      }
      action={
        blocked ? null : busy ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={Boolean(needsOrca)}
            aria-label={translate(
              'auto.components.settings.PluginManagerRows.installName',
              'Install {{value0}}',
              {
                value0: entry.name
              }
            )}
            onClick={() => onInstall(entry)}
          >
            {translate('auto.components.settings.PluginMarketplaceListingRow.install', 'Install')}
          </Button>
        )
      }
      more={
        <MoreButton name={entry.name}>
          <DetailsItem onSelect={() => onOpen(entry)} />
          <DropdownMenuItem onSelect={() => void copyPluginId(entry.pluginKey)}>
            <Copy />
            {translate('auto.components.settings.PluginManagerRows.copyId', 'Copy plugin ID')}
          </DropdownMenuItem>
        </MoreButton>
      }
      onOpen={() => onOpen(entry)}
    />
  )
}
