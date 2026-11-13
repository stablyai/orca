import { ArrowUpCircle, Copy, FileText, Hash, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '../../ui/dropdown-menu'
import type { PluginListEntry } from './plugin-list-entries'
import { Switch } from '@/components/ui/switch'
import {
  pluginNeedsReview,
  installedPluginPresentation,
  type PluginStatusKind
} from '../presentation/plugin-status-presentation'
import { invalidPluginErrorMessage } from '../presentation/plugin-error-presentation'
import { usePluginRollbackVersion } from '../state/use-plugin-rollback-version'
import { copyContentHash, copyPluginId, DetailsItem, MoreButton } from './PluginRowMenu'
import { StatusWord } from './PluginStatusWord'
import { isQualifiedPluginKey } from '../../../../../shared/plugins/manifest/plugin-manifest'

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

type InstalledPluginControls = {
  kind: PluginStatusKind
  statusText: string
  description: React.ReactNode
  tone: 'default' | 'destructive'
  status: React.ReactNode
  action: React.ReactNode
  toggle: React.ReactNode
  more: React.ReactNode
}

/** What an installed plugin shows and offers, shared by its card and its page. */
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
  },
  t: Translate = translate
): InstalledPluginControls {
  const { kind, enabled, statusText, removable, primary, switchable } = installedPluginPresentation(
    plugin,
    entry.updateVersion,
    busy,
    entry.autoUpdate,
    entry.reinstallVersion ?? null,
    t
  )
  const needsReview = pluginNeedsReview(plugin)
  const canUnload = plugin.isDev && isQualifiedPluginKey(plugin.pluginKey)

  let description: React.ReactNode = entry.description ?? ''
  let tone: 'default' | 'destructive' = 'default'
  if (plugin.blockedByKillList) {
    tone = 'destructive'
    description = t(
      'auto.components.settings.PluginSettingsRow.killListMessage',
      "Orca's safety list disabled this plugin: {{value0}}",
      { value0: plugin.blockedByKillList.reason }
    )
  } else if (kind === 'invalid' && plugin.error) {
    tone = 'destructive'
    description = invalidPluginErrorMessage(plugin.error, !plugin.isDev, t)
  } else if (kind === 'error' && plugin.execution === 'data') {
    // Why: content-only plugins have no code or logs; only their files can fail.
    tone = 'destructive'
    description = t(
      'auto.components.settings.PluginManagerRows.dataLoadFailed',
      'Couldn’t load its files'
    )
  } else if (kind === 'error') {
    tone = 'destructive'
    description =
      plugin.restarts === 1
        ? t('auto.components.settings.PluginManagerRows.crashedOnce', 'Crashed once')
        : plugin.restarts > 1
          ? t(
              'auto.components.settings.PluginManagerRows.crashedCount',
              'Crashed {{value0}} times in a row',
              { value0: plugin.restarts }
            )
          : t('auto.components.settings.PluginManagerRows.crashed', 'Crashed while starting')
  }

  let action: React.ReactNode = null
  if (primary === 'busy') {
    action = <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
  } else if (primary === 'remove') {
    action = (
      <Button
        variant="outline"
        size="xs"
        onClick={() => handlers.onRemoveRequest(plugin.pluginKey)}
      >
        {t('auto.components.settings.PluginManagerRows.remove', 'Remove…')}
      </Button>
    )
  } else if (primary === 'review') {
    action = (
      <Button size="xs" onClick={() => handlers.onReview(plugin.pluginKey)}>
        {t('auto.components.settings.PluginManagerRows.review', 'Review')}
      </Button>
    )
  } else if (primary === 'restart') {
    action = (
      <Button variant="outline" size="xs" onClick={() => handlers.onRestart(plugin.pluginKey)}>
        <RotateCcw />
        {t('auto.components.settings.PluginManagerRows.restart', 'Restart')}
      </Button>
    )
  } else if (primary === 'update') {
    action = (
      <Button
        variant="outline"
        size="xs"
        aria-label={t(
          'auto.components.settings.PluginManagerRows.updateLabel',
          'Update {{value0}} to {{value1}}',
          { value0: entry.name, value1: entry.updateVersion }
        )}
        onClick={() => handlers.onCheckUpdate(entry)}
      >
        <ArrowUpCircle />
        {entry.autoUpdate.needsReview
          ? t('auto.components.settings.PluginManagerRows.reviewUpdate', 'Review update')
          : t('auto.components.settings.PluginManagerRows.update', 'Update {{value0}}', {
              value0: entry.updateVersion
            })}
      </Button>
    )
  } else if (primary === 'reinstall') {
    action = (
      <Button variant="outline" size="xs" onClick={() => handlers.onCheckUpdate(entry)}>
        <RotateCcw />
        {t('auto.components.settings.PluginManagerRows.reinstall', 'Reinstall')}
      </Button>
    )
  } else if (primary === 'error') {
    action = (
      <Button variant="outline" size="xs" onClick={() => handlers.onOpen(plugin.pluginKey)}>
        {t('auto.components.settings.PluginManagerRows.viewError', 'View error')}
      </Button>
    )
  }

  return {
    kind,
    statusText,
    description,
    tone,
    // Why none for review: the Review button and the off switch already say it.
    status: kind === 'review' ? null : <StatusWord kind={kind} />,
    action,
    toggle: (
      <span className="relative inline-flex">
        <Switch
          checked={enabled && !needsReview}
          disabled={!switchable}
          onCheckedChange={() => handlers.onToggleEnabled(plugin.pluginKey)}
          aria-label={
            enabled && !needsReview
              ? t('auto.components.settings.PluginSettingsRow.disableLabel', 'Disable {{value0}}', {
                  value0: entry.name
                })
              : t('auto.components.settings.PluginSettingsRow.enableLabel', 'Enable {{value0}}', {
                  value0: entry.name
                })
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
      <MoreButton name={entry.name}>
        {inPage ? null : <DetailsItem onSelect={() => handlers.onOpen(plugin.pluginKey)} />}
        {plugin.hasWorker && !inPage ? (
          <DropdownMenuItem onSelect={() => handlers.onViewLogs(plugin.pluginKey)}>
            <FileText />
            {t('auto.components.settings.PluginSettingsRow.viewLogs', 'View logs')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyPluginId(plugin.pluginKey)}>
          <Copy />
          {t('auto.components.settings.PluginManagerRows.copyId', 'Copy plugin ID')}
        </DropdownMenuItem>
        {inPage && plugin.source?.contentHash ? (
          <DropdownMenuItem onSelect={() => void copyContentHash(plugin.source?.contentHash ?? '')}>
            <Hash />
            {t('auto.components.settings.PluginManagerRows.copyContentHash', 'Copy content hash')}
          </DropdownMenuItem>
        ) : null}
        {canCheckUpdate ? (
          <DropdownMenuItem onSelect={() => handlers.onCheckUpdate(entry)}>
            <ArrowUpCircle />
            {t('auto.components.settings.PluginManagerRows.checkUpdate', 'Check for update')}
          </DropdownMenuItem>
        ) : null}
        {plugin.source?.kind === 'marketplace' || removable || canUnload || plugin.bundled ? (
          <DropdownMenuSeparator />
        ) : null}
        {plugin.source?.kind === 'marketplace' ? (
          <RollbackItem
            pluginKey={plugin.pluginKey}
            onSelect={() => handlers.onRollbackRequest(plugin.pluginKey)}
          />
        ) : null}
        {canUnload ? (
          <DropdownMenuItem onSelect={() => handlers.onRemoveRequest(plugin.pluginKey)}>
            <Trash2 />
            {t(
              'auto.components.settings.PluginManagerRows.unloadDevFolder',
              'Remove development folder…'
            )}
          </DropdownMenuItem>
        ) : removable ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => handlers.onRemoveRequest(plugin.pluginKey)}
          >
            <Trash2 />
            {t('auto.components.settings.PluginManagerRows.remove', 'Remove…')}
          </DropdownMenuItem>
        ) : plugin.bundled ? (
          <DropdownMenuItem disabled>
            <Trash2 />
            {t('auto.components.settings.PluginManagerRows.bundledWithOrca', 'Bundled with Orca')}
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
  const t = useTranslate()
  const version = usePluginRollbackVersion(pluginKey)
  if (!version) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <RotateCcw />
      {t('auto.components.settings.PluginManagerRows.rollbackTo', 'Roll back to {{value0}}…', {
        value0: version
      })}
    </DropdownMenuItem>
  )
}
