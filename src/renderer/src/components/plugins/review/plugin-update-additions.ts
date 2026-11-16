import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { Translate } from '@/i18n/use-translate'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { updateChanges } from './PluginUpdateCandidate'

/**
 * What an update that needs approval adds, one named line each, as the review dialog and the
 * toast show it. Why the installed manifest is a loaded input, not read here: whoever offers
 * "Approve & update" must have every line in hand before the button exists.
 */
export function pluginUpdateAdditions(
  preview: PluginMarketplaceHostInstallPreview,
  installedManifest: PluginManifest | null,
  t: Translate
): { lines: string[]; compared: boolean } {
  // Why main's list: it compares whole grants, so a wider scope of a held kind is new too.
  const { capabilities, warnings } = updateChanges(preview, t, installedManifest)
  return {
    lines: [
      // Why no URLs: the version link opens the new repository's history, and "Source" names it.
      ...(preview.repositoryMoved
        ? [
            t(
              'auto.components.settings.PluginUpdateAllDialog.movedRepository',
              'Comes from a different repository'
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
