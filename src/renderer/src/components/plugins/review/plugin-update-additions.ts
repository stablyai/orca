import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { Translate } from '@/i18n/use-translate'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { movedFromSource, sourceLabel, updateChanges } from './PluginUpdateCandidate'

/**
 * What an update that needs approval adds, one named line each, as the review dialog and the
 * toast show it. Why the installed manifest is a loaded input, not read here: whoever offers
 * "Approve & update" must have every line in hand before the button exists.
 */
export function pluginUpdateAdditions(
  installed: PluginHostListEntry | null | undefined,
  preview: PluginMarketplaceHostInstallPreview,
  installedManifest: PluginManifest | null,
  t: Translate
): { lines: string[]; compared: boolean } {
  // Why main's list: it compares whole grants, so a wider scope of a held kind is new too.
  const { capabilities, warnings } = updateChanges(preview, t, installedManifest)
  const movedFrom = movedFromSource(installed, preview)
  return {
    lines: [
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
    ],
    // Why only a missing comparison: a moved source alone still has a comparison to show.
    compared: preview.accessGrowth !== undefined
  }
}

/** The installed manifest, or null when it can't be read (editor lines then stay generic). */
export function readInstalledManifest(pluginKey: string): Promise<PluginManifest | null> {
  return window.api.plugins.getInstalledManifest({ pluginKey }).catch((cause: unknown) => {
    console.warn('[plugins] installed manifest read failed:', cause)
    return null
  })
}
