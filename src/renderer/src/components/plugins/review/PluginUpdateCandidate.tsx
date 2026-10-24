import { Check } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../../shared/plugins/plugin-execution-profile'
import type { PluginContributionPoint } from '../../../../../shared/plugins/plugin-contribution-points'
import { pluginContributionSummary } from '../../../../../shared/plugins/plugin-contribution-summary'
import { translate } from '@/i18n/i18n'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginCatalogAvatar } from '../list/PluginCatalogAvatar'
import { Checkbox } from '../../ui/checkbox'
import { PluginConsentProvenance } from './PluginConsentProvenance'
import { pluginPointsFromManifest, pluginTrust } from '../presentation/plugin-access-profile'
import { pluginTrustWarnings } from '../presentation/plugin-consent-copy'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'

export type UpdateCandidate = {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview | null
  error: boolean
  /** Oldest Orca the update runs on, when this Orca is older. */
  needsOrca: string | null
}

/** The installed repository when main found the catalog now points the update somewhere else. */
export function movedFromSource(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview
): string | null {
  if (!preview.repositoryMoved) {
    return null
  }
  const installed = entry.installed?.source
  return installed?.kind === 'marketplace' ? installed.reference : ''
}

const contributionGrowthLabel = (point: PluginContributionPoint): string => {
  if (point === 'keybindings') {
    return translate(
      'auto.components.settings.PluginUpdateAllDialog.newShortcuts',
      'Adds keyboard shortcuts'
    )
  }
  if (point === 'commands') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newCommands', 'Adds commands')
  }
  if (point === 'panels') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newPanels', 'Adds panels')
  }
  if (point === 'events') {
    return translate(
      'auto.components.settings.PluginUpdateAllDialog.newEvents',
      'Listens for more events'
    )
  }
  if (point === 'vmRecipes') {
    return translate(
      'auto.components.settings.PluginUpdateAllDialog.newRecipes',
      'Changes virtual machine recipes'
    )
  }
  return translate(
    'auto.components.settings.PluginUpdateAllDialog.newContributions',
    'Adds new features that act for you'
  )
}

/** What main found the update adds over the installed version, as review lines. */
function updateChanges(preview: PluginMarketplaceHostInstallPreview): {
  capabilities: string[]
  warnings: string[]
} {
  const growth = preview.accessGrowth
  const execution = growth?.execution
    ? pluginTrustWarnings(
        pluginTrust({
          execution: growth.execution,
          points: pluginPointsFromManifest(preview.manifest)
        })
      )
    : []
  const contributions = (growth?.contributions ?? []).map(contributionGrowthLabel)
  return {
    capabilities: growth?.capabilities ?? [],
    warnings: [...new Set([...execution, ...contributions])]
  }
}

export function updateAsksAgain(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview
): boolean {
  const changes = updateChanges(preview)
  return (
    changes.capabilities.length > 0 ||
    changes.warnings.length > 0 ||
    movedFromSource(entry, preview) !== null
  )
}

export function isCurrent(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview | null
): boolean {
  return Boolean(preview && entry.installed?.source?.contentHash === preview.contentHash)
}

export function CandidateRow({
  candidate,
  done,
  checked,
  disabled,
  onCheckedChange
}: {
  candidate: UpdateCandidate
  done: boolean
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const { entry, preview, error, needsOrca } = candidate
  const { capabilities: added, warnings } = preview
    ? updateChanges(preview)
    : { capabilities: [], warnings: [] }
  const movedFrom = preview ? movedFromSource(entry, preview) : null
  const checkboxId = `plugin-update-${entry.pluginKey}`
  let note: React.ReactNode
  if (done) {
    note = (
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden="true" />
        {translate('auto.components.settings.PluginUpdateAllDialog.updated', 'Updated')}
      </p>
    )
  } else if (error) {
    note = (
      <p className="mt-0.5 text-xs text-destructive">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.previewError',
          'Couldn’t read this update. It will be skipped.'
        )}
      </p>
    )
  } else if (preview?.blockedByKillList) {
    note = (
      <p className="mt-0.5 text-xs text-destructive">
        {translate(
          'auto.components.settings.PluginMarketplaceListingRow.blocked',
          "Blocked by Orca's safety list: {{value0}}",
          { value0: preview.blockedByKillList.reason }
        )}
      </p>
    )
  } else if (isCurrent(entry, preview)) {
    note = (
      <p className="mt-0.5 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.current',
          'This exact plugin content is already installed.'
        )}
      </p>
    )
  } else if (needsOrca) {
    note = (
      <p className="mt-0.5 text-xs text-status-warning-text">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.needsOrca',
          'Needs Orca {{value0}} or later. Update Orca first.',
          { value0: needsOrca }
        )}
      </p>
    )
  } else if (added.length > 0 || warnings.length > 0 || movedFrom !== null) {
    note = (
      <ul className="mt-1.5 space-y-0.5 border-l-2 border-status-warning pl-2 text-xs">
        {movedFrom !== null && preview ? (
          <li className="text-status-warning-text">
            {translate(
              'auto.components.settings.PluginUpdateAllDialog.sourceMoved',
              'Now comes from a different repository: {{value0}} (was {{value1}})',
              { value0: preview.source.url, value1: movedFrom }
            )}
          </li>
        ) : null}
        {warnings.map((warning) => (
          <li key={warning} className="text-status-warning-text">
            {warning}
          </li>
        ))}
        {added.map((kind) => (
          <li key={kind} className="text-status-warning-text">
            {translate(
              'auto.components.settings.PluginUpdateAllDialog.newAccess',
              'New access: {{value0}}',
              { value0: pluginCapabilityDescription(kind, kind) }
            )}
          </li>
        ))}
      </ul>
    )
  } else {
    note = (
      <p className="mt-0.5 text-xs text-muted-foreground">
        {translate('auto.components.settings.PluginUpdateAllDialog.noNewAccess', 'No new access')}
      </p>
    )
  }
  return (
    <li data-plugin-update={entry.pluginKey} className="flex items-start gap-3 py-2.5">
      <PluginCatalogAvatar name={entry.name} className="size-7 rounded-md text-3xs" />
      <div className="min-w-0 flex-1">
        <label htmlFor={checkboxId} className="text-sm font-medium">
          {entry.name}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {entry.installed?.version} → {preview?.manifest.version ?? entry.updateVersion}
          </span>
        </label>
        {note}
        {preview ? (
          <div className="mt-2 space-y-1.5">
            <PluginConsentProvenance
              official={preview.official}
              publisher={preview.manifest.publisher}
              source={{
                kind: preview.bundled ? 'bundled' : 'marketplace',
                reference: `${preview.source.url}#${preview.source.ref}`,
                resolvedCommit: preview.resolvedCommit,
                marketplace: {
                  reference: preview.marketplaceName,
                  resolvedCommit: preview.marketplaceCommit
                }
              }}
            />
            {preview.manifest.description ? (
              <p className="text-xs text-muted-foreground">{preview.manifest.description}</p>
            ) : null}
            <ul className="text-xs text-muted-foreground">
              {pluginContributionSummary(preview.manifest).map((item) => (
                <li key={`${item.kind}:${item.name}:${item.detail ?? ''}`}>
                  {item.name}
                  {item.detail ? ` · ${item.detail}` : ''}
                </li>
              ))}
            </ul>
            {preview.manifest.capabilities.map((capability) => (
              <p key={capability.kind} className="text-xs text-muted-foreground">
                {pluginCapabilityDescription(capability.kind, capability.kind)}
              </p>
            ))}
            {pluginTrustWarnings(
              pluginTrust({
                execution: pluginExecutionProfile(preview.manifest),
                points: pluginPointsFromManifest(preview.manifest)
              })
            )
              .filter((warning) => !warnings.includes(warning))
              .map((warning) => (
                <p key={warning} className="text-xs text-muted-foreground">
                  {warning}
                </p>
              ))}
          </div>
        ) : null}
      </div>
      <Checkbox
        id={checkboxId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
    </li>
  )
}
