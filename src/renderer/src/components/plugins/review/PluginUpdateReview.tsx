import { ArrowRight } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { reachablePluginCapabilities } from '../../../../../shared/plugins/capabilities/plugin-capability-reach'
import { translate } from '@/i18n/i18n'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import {
  installedPluginTrust,
  pluginPointsFromManifest,
  pluginTrust
} from '../presentation/plugin-access-profile'
import { pluginTrustLabel } from '../presentation/plugin-consent-copy'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { pluginPublisherNotice } from '../presentation/plugin-publisher-trust'
import { useInstalledPluginManifest } from '../state/use-plugin-contribution-source'
import { PluginNotOfficialWarning } from './PluginNotOfficialWarning'
import { AllAccess, movedFromSource, sourceLabel, updateChanges } from './PluginUpdateCandidate'

type AccessLine = { text: string; added: boolean }

function AccessColumn({
  title,
  lines
}: {
  title: string
  lines: readonly AccessLine[]
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="space-y-1 text-sm">
        {lines.map((line) =>
          line.added ? (
            <li key={line.text} data-added="" className="text-status-warning-text">
              {translate(
                'auto.components.settings.PluginUpdateAllDialog.newAccess',
                'New: {{value0}}',
                {
                  value0: line.text
                }
              )}
            </li>
          ) : (
            <li key={line.text}>{line.text}</li>
          )
        )}
      </ul>
    </div>
  )
}

/**
 * One update that asks for more than the installed version: what it could do before, what it
 * could do after, with every addition marked. Approving here is the only way such an update lands.
 */
export function PluginUpdateReview({
  entry,
  preview
}: {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview
}): React.JSX.Element {
  const installed = entry.installed
  const installedManifest = useInstalledPluginManifest(installed)
  const execution = pluginExecutionProfile(preview.manifest)
  const afterTrust = pluginTrust({
    execution,
    points: pluginPointsFromManifest(preview.manifest),
    hasWorker: preview.manifest.main !== undefined
  })
  const beforeTrust = installed ? installedPluginTrust(installed, installedManifest) : null
  const beforeLabel = beforeTrust ? pluginTrustLabel(beforeTrust) : null
  const afterLabel = pluginTrustLabel(afterTrust)
  // Why main's list: it compares whole grants, so a wider scope of a held kind is new too.
  const { capabilities: grown, warnings } = updateChanges(preview)
  const movedFrom = movedFromSource(entry, preview)
  const notice = pluginPublisherNotice({
    official: preview.official,
    execution,
    manifest: preview.manifest,
    types: null
  })

  const before: AccessLine[] = [
    ...(beforeLabel ? [{ text: beforeLabel, added: false }] : []),
    ...(installed?.capabilities ?? []).map((capability) => ({
      text: pluginCapabilityDescription(capability.kind, capability.description),
      added: false
    }))
  ]
  const after: AccessLine[] = [
    { text: afterLabel, added: beforeLabel !== null && beforeLabel !== afterLabel },
    ...warnings.map((text) => ({ text, added: true })),
    ...reachablePluginCapabilities(preview.manifest.capabilities, execution).map((capability) => ({
      text: pluginCapabilityDescription(capability.kind, capability.kind),
      added: grown.includes(capability.kind)
    }))
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
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.settings.PluginUpdateReview.explain',
          'This update asks for more than the version you approved. It installs only if you approve it here.'
        )}
      </p>
      {movedFrom !== null ? (
        <p className="text-sm text-status-warning-text">
          {translate(
            'auto.components.settings.PluginUpdateAllDialog.sourceMoved',
            'New source: {{value0}} (was {{value1}})',
            { value0: sourceLabel(preview.source), value1: movedFrom }
          )}
        </p>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <AccessColumn
          title={translate('auto.components.settings.PluginUpdateReview.before', 'Before')}
          lines={before}
        />
        <ArrowRight className="mt-6 size-4 text-muted-foreground" aria-hidden="true" />
        <AccessColumn
          title={translate('auto.components.settings.PluginUpdateReview.after', 'After')}
          lines={after}
        />
      </div>
      <AllAccess preview={preview} execution={execution} />
    </div>
  )
}
