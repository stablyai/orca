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

const STATUS_WORDS: Record<PluginStatusKind, () => string> = {
  blocked: () => translate('auto.components.settings.PluginStatus.blocked', 'Blocked'),
  review: () => translate('auto.components.settings.PluginStatus.needsReview', 'Needs review'),
  restarting: () => translate('auto.components.settings.PluginStatus.restarting', 'Restarting'),
  error: () => translate('auto.components.settings.PluginStatus.stopped', 'Stopped'),
  invalid: () => translate('auto.components.settings.PluginStatus.cantLoad', 'Can’t load'),
  disabled: () => translate('auto.components.settings.PluginStatus.off', 'Off'),
  running: () => translate('auto.components.settings.PluginStatus.running', 'Running'),
  enabled: () => translate('auto.components.settings.PluginStatus.on', 'On')
}

/** The one word every surface shows for a status. */
export function pluginStatusWord(kind: PluginStatusKind): string {
  return STATUS_WORDS[kind]()
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
  busy: boolean,
  autoUpdate: { updatedTo: string | null; needsReview: boolean },
  reinstallVersion: string | null = null
) {
  const kind = pluginStatusKind(plugin)
  const removable = !plugin.bundled && !plugin.isDev
  // First match wins: each earlier state blocks the later actions from doing anything useful.
  const primaryRules = [
    [busy, 'busy'],
    [Boolean(plugin.blockedByKillList) && removable, 'remove'],
    [pluginNeedsReview(plugin), 'review'],
    [kind === 'error', 'restart'],
    [Boolean(updateVersion), 'update'],
    [kind === 'invalid' && Boolean(reinstallVersion), 'reinstall'],
    [kind === 'invalid', 'error']
  ] as const
  const primary = primaryRules.find(([applies]) => applies)?.[1] ?? null
  const fact =
    updateVersion && autoUpdate.needsReview
      ? translate(
          'auto.components.settings.PluginManagerRows.updateNeedsReview',
          'update {{value0}} needs review',
          { value0: updateVersion }
        )
      : updateVersion
        ? translate(
            'auto.components.settings.PluginManagerRows.updateAvailable',
            'update {{value0}} available',
            { value0: updateVersion }
          )
        : autoUpdate.updatedTo
          ? translate(
              'auto.components.settings.PluginManagerRows.updatedTo',
              'updated to {{value0}}',
              { value0: autoUpdate.updatedTo }
            )
          : null
  return {
    kind,
    removable,
    primary,
    enabled: isPluginEnabled(plugin),
    switchable: !busy && kind !== 'review' && kind !== 'invalid' && kind !== 'blocked',
    statusText: fact ? `${pluginStatusWord(kind)}, ${fact}` : pluginStatusWord(kind)
  }
}
