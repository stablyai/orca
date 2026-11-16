import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useTranslate } from '@/i18n/use-translate'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { useInstalledPluginManifest } from '../state/use-plugin-contribution-source'
import { movedFromSource, sourceLabel, updateChanges } from './PluginUpdateCandidate'

export type PluginUpdateAdditions = {
  /** One line per thing the update adds, each named. */
  lines: string[]
  /** False when main couldn't compare the update with the installed version. */
  compared: boolean
  /** False until the installed manifest is read; editor lines name file types from it. */
  ready: boolean
}

/** What an update that needs approval adds, as the review dialog and the toast both show it. */
export function usePluginUpdateAdditions(
  installed: PluginHostListEntry | null | undefined,
  preview: PluginMarketplaceHostInstallPreview | null
): PluginUpdateAdditions {
  const t = useTranslate()
  const installedManifest = useInstalledPluginManifest(installed ?? null)
  if (!preview) {
    return { lines: [], compared: true, ready: false }
  }
  // Why main's list: it compares whole grants, so a wider scope of a held kind is new too.
  const { capabilities, warnings } = updateChanges(preview, t, installedManifest)
  const movedFrom = movedFromSource(installed, preview)
  const lines = [
    ...(movedFrom !== null
      ? [
          t(
            'auto.components.settings.PluginUpdateAllDialog.sourceMoved',
            'New source: {{value0}} (was {{value1}})',
            { value0: sourceLabel(preview.source), value1: movedFrom }
          )
        ]
      : []),
    ...warnings,
    // Why unfiltered: main asks again for every new grant, even one this plugin type can't use yet.
    ...capabilities.map((kind) => pluginCapabilityDescription(kind, kind, t))
  ]
  return {
    lines,
    // Why only a missing comparison: a moved source alone still has a comparison to show.
    compared: preview.accessGrowth !== undefined,
    ready: installedManifest !== undefined
  }
}
