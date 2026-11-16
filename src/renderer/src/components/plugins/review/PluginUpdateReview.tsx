import { Plus } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { pluginCapabilityReachable } from '../../../../../shared/plugins/capabilities/plugin-capability-reach'
import { useTranslate } from '@/i18n/use-translate'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { pluginPublisherNotice } from '../presentation/plugin-publisher-trust'
import { useInstalledPluginManifest } from '../state/use-plugin-contribution-source'
import { PluginNotOfficialWarning } from './PluginNotOfficialWarning'
import { AllAccess, movedFromSource, sourceLabel, updateChanges } from './PluginUpdateCandidate'

/**
 * One update that asks for more than the installed version. Why only the additions: what the
 * plugin could already do was approved before, and repeating it hides the one line that matters.
 * Everything else stays behind "See all access". Approving here is the only way such an update lands.
 */
export function PluginUpdateReview({
  entry,
  preview
}: {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview
}): React.JSX.Element {
  const t = useTranslate()
  const installed = entry.installed
  const installedManifest = useInstalledPluginManifest(installed)
  const execution = pluginExecutionProfile(preview.manifest)
  // Why main's list: it compares whole grants, so a wider scope of a held kind is new too.
  const { capabilities: grown, warnings } = updateChanges(preview, t, installedManifest)
  const movedFrom = movedFromSource(entry, preview)
  const notice = pluginPublisherNotice({
    official: preview.official,
    execution,
    manifest: preview.manifest,
    types: null
  })
  const additions = [
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
    ...grown
      .filter((kind) => pluginCapabilityReachable(kind, execution))
      .map((kind) => pluginCapabilityDescription(kind, kind, t))
  ]

  return (
    <div data-plugin-update-review={entry.pluginKey} className="space-y-4">
      {notice !== 'none' ? (
        <PluginNotOfficialWarning
          notice={notice}
          publisher={preview.manifest.publisher ?? null}
          moment="update"
        />
      ) : null}
      <div className="flex items-center gap-3">
        <PluginRowArt entry={entry} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry.name}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {installed?.version} → {preview.manifest.version}
          </span>
        </p>
      </div>
      {additions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t(
              'auto.components.settings.PluginUpdateReview.asksFor',
              'This version can do more than the one you approved:'
            )}
          </p>
          <ul className="space-y-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
            {additions.map((line) => (
              <li key={line} data-added="" className="flex items-start gap-2">
                <Plus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            'auto.components.settings.PluginUpdateReview.uncompared',
            'Orca couldn’t compare this version with the one you approved. Check what it can access before you update.'
          )}
        </p>
      )}
      <AllAccess preview={preview} execution={execution} defaultOpen={additions.length === 0} />
    </div>
  )
}
