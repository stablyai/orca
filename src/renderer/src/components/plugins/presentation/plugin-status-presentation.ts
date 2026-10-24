import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

/** What an installed plugin's state means to the user; one word each, never colour alone. */
export type PluginStatusKind =
  | 'blocked'
  | 'review'
  | 'restarting'
  | 'error'
  | 'invalid'
  | 'disabled'
  | 'running'
  | 'enabled'

type PluginStatusFields = Pick<
  PluginHostListEntry,
  'status' | 'needsReconsent' | 'blockedByKillList'
>

export function pluginNeedsReview(plugin: Pick<PluginHostListEntry, 'status' | 'needsReconsent'>) {
  return plugin.needsReconsent || plugin.status === 'pending'
}

/** The user has it switched on; a crashed plugin still counts, so the switch can turn it off. */
export function isPluginEnabled(plugin: Pick<PluginHostListEntry, 'status'>): boolean {
  return (
    plugin.status === 'running' ||
    plugin.status === 'restarting' ||
    plugin.status === 'idle' ||
    plugin.status === 'errored'
  )
}

export function pluginStatusKind(plugin: PluginStatusFields): PluginStatusKind {
  if (plugin.blockedByKillList) {
    return 'blocked'
  }
  if (pluginNeedsReview(plugin)) {
    return 'review'
  }
  if (plugin.status === 'restarting') {
    return 'restarting'
  }
  if (plugin.status === 'errored') {
    return 'error'
  }
  if (plugin.status === 'invalid') {
    return 'invalid'
  }
  if (plugin.status === 'disabled') {
    return 'disabled'
  }
  return plugin.status === 'running' ? 'running' : 'enabled'
}

export function pluginStatusLabel(kind: PluginStatusKind): string {
  switch (kind) {
    case 'blocked':
      return translate('auto.components.settings.PluginSettingsRow.blocked', 'Blocked')
    case 'review':
      return translate('auto.components.settings.PluginSettingsRow.needsReview', 'Needs review')
    case 'restarting':
      return translate('auto.components.settings.PluginSettingsRow.restarting', 'Restarting')
    case 'error':
      return translate('auto.components.settings.PluginSettingsRow.error', 'Error')
    case 'invalid':
      return translate('auto.components.settings.PluginSettingsRow.invalid', 'Invalid')
    case 'disabled':
      return translate('auto.components.settings.PluginSettingsRow.disabled', 'Disabled')
    case 'running':
      return translate('auto.components.settings.PluginSettingsRow.running', 'Running')
    case 'enabled':
      return translate('auto.components.settings.PluginSettingsRow.enabled', 'Enabled')
  }
}

const NEEDS_ATTENTION: ReadonlySet<PluginStatusKind> = new Set([
  'blocked',
  'review',
  'error',
  'invalid'
])

/** Installed order: plugins that need the user first, then pending updates, then the rest. */
export function sortByAttention<T extends { installed: PluginHostListEntry | null }>(
  entries: readonly T[],
  hasUpdate: (entry: T) => boolean
): T[] {
  const rank = (entry: T): number =>
    entry.installed && NEEDS_ATTENTION.has(pluginStatusKind(entry.installed))
      ? 0
      : hasUpdate(entry)
        ? 1
        : 2
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry)
}

/** One installed-action priority; surfaces choose only their layout. */
export function installedPluginPresentation(
  plugin: PluginHostListEntry,
  updateVersion: string | null,
  busy = false,
  autoUpdate: { updatedTo: string | null; needsReview: boolean } | null = null
) {
  const kind = pluginStatusKind(plugin)
  const removable = !plugin.bundled && !plugin.isDev
  const primary = busy
    ? 'busy'
    : plugin.blockedByKillList && removable
      ? 'remove'
      : pluginNeedsReview(plugin)
        ? 'review'
        : kind === 'error'
          ? 'restart'
          : updateVersion
            ? 'update'
            : kind === 'invalid'
              ? 'error'
              : null
  return {
    kind,
    removable,
    primary,
    enabled: isPluginEnabled(plugin),
    switchable: !busy && kind !== 'review' && kind !== 'invalid' && kind !== 'blocked',
    statusText:
      updateVersion && autoUpdate?.needsReview
        ? `${statusWordFor(kind)}, ${translate('auto.components.settings.PluginManagerRows.updateNeedsReview', 'update {{value0}} needs review', { value0: updateVersion })}`
        : updateVersion
          ? `${statusWordFor(kind)}, ${translate('auto.components.settings.PluginManagerRows.updateAvailable', 'update {{value0}} available', { value0: updateVersion })}`
          : autoUpdate?.updatedTo
            ? `${statusWordFor(kind)}, ${translate('auto.components.settings.PluginManagerRows.updatedTo', 'updated to {{value0}}', { value0: autoUpdate.updatedTo })}`
            : statusWordFor(kind)
  }
}

export function statusWordFor(kind: PluginStatusKind): string {
  if (kind === 'error') {
    return translate('auto.components.settings.PluginManagerRows.stopped', 'Stopped')
  }
  if (kind === 'invalid') {
    return translate('auto.components.settings.PluginManagerRows.cantLoad', 'Can’t load')
  }
  if (kind === 'enabled') {
    return translate('auto.components.settings.PluginManagerRows.on', 'On')
  }
  if (kind === 'disabled') {
    return translate('auto.components.settings.PluginManagerRows.off', 'Off')
  }
  return pluginStatusLabel(kind)
}
