import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import type { PluginListEntry } from '../list/plugin-list-entries'

const COMPACT_OPTIONS: Intl.NumberFormatOptions = { notation: 'compact', maximumFractionDigits: 1 }

/** "1.2k": compact and lowercase, as the plugin site shows it. */
export function formatPluginInstallCount(count: number, intlLocale?: string): string {
  return uiNumberFormat(COMPACT_OPTIONS, intlLocale)
    .format(Math.max(0, Math.trunc(count)))
    .toLowerCase()
}

export function pluginInstallCountLabel(
  count: number,
  t: Translate = translate,
  intlLocale?: string
): string {
  return t('auto.components.plugins.pluginInstallCount.installs', '{{value0}} installs', {
    value0: formatPluginInstallCount(count, intlLocale)
  })
}

/** The entry's public install count, or null when it has none or is not an eligible catalog plugin. */
export function usePluginInstallCount(entry: PluginListEntry): number | null {
  const count = usePluginInstallCountsStore((state) => state.counts[entry.pluginKey])
  return entry.installCountEligible && typeof count === 'number' ? count : null
}
