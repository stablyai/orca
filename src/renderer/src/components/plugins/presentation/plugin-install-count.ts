import { translate } from '@/i18n/i18n'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { usePluginInstallCountsStore } from '@/store/plugin-install-counts'
import type { PluginListEntry } from '../list/plugin-list-entries'

const COMPACT_OPTIONS: Intl.NumberFormatOptions = { notation: 'compact', maximumFractionDigits: 1 }

/** "1.2k": compact and lowercase, as the plugin site shows it. */
export function formatPluginInstallCount(count: number): string {
  return uiNumberFormat(COMPACT_OPTIONS)
    .format(Math.max(0, Math.trunc(count)))
    .toLowerCase()
}

export function pluginInstallCountLabel(count: number): string {
  return translate('auto.components.plugins.pluginInstallCount.installs', '{{value0}} installs', {
    value0: formatPluginInstallCount(count)
  })
}

/** The entry's public install count, or null when it has none or is not an eligible catalog plugin. */
export function usePluginInstallCount(entry: PluginListEntry): number | null {
  const count = usePluginInstallCountsStore((state) => state.counts[entry.pluginKey])
  return entry.installCountEligible && typeof count === 'number' ? count : null
}
