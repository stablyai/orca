import { Check, ChevronDown } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import {
  pluginCapabilityReachable,
  reachablePluginCapabilities
} from '../../../../../shared/plugins/capabilities/plugin-capability-reach'
import type { PluginContributionPoint } from '../../../../../shared/plugins/contributions/plugin-contribution-points'
import { translate } from '@/i18n/i18n'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
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

// Why the same form as main's list projection: `movedFrom` is compared against it by eye.
const sourceLabel = (source: { url: string; path?: string }): string =>
  source.path ? `${source.url} (${source.path})` : source.url

const contributionGrowthLabel = (point: PluginContributionPoint): string => {
  if (point === 'keybindings') {
    return translate(
      'auto.components.settings.PluginUpdateAllDialog.newShortcuts',
      'Keyboard shortcuts'
    )
  }
  if (point === 'commands') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newCommands', 'Commands')
  }
  if (point === 'panels') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newPanels', 'Panels')
  }
  if (point === 'events') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newEvents', 'More events')
  }
  if (point === 'vmRecipes') {
    return translate('auto.components.settings.PluginUpdateAllDialog.newRecipes', 'Machine recipes')
  }
  return translate(
    'auto.components.settings.PluginUpdateAllDialog.newContributions',
    'Features that act for you'
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
  // Why: a panel profile has no trust warning of its own, but its growth still asks again.
  const executionLines =
    growth?.execution && execution.length === 0 ? [contributionGrowthLabel('panels')] : execution
  const contributions = (growth?.contributions ?? []).map(contributionGrowthLabel)
  return {
    capabilities: growth?.capabilities ?? [],
    warnings: [...new Set([...executionLines, ...contributions])]
  }
}

export function isCurrent(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview | null
): boolean {
  return Boolean(preview && entry.installed?.source?.contentHash === preview.contentHash)
}

function NewLine({ children }: { children: string }): React.JSX.Element {
  return (
    <li className="text-status-warning-text">
      {translate('auto.components.settings.PluginUpdateAllDialog.newAccess', 'New: {{value0}}', {
        value0: children
      })}
    </li>
  )
}

/** Everything the update can reach, for the rare reader who wants more than what's new. */
function AllAccess({
  preview,
  execution
}: {
  preview: PluginMarketplaceHostInstallPreview
  execution: ReturnType<typeof pluginExecutionProfile>
}): React.JSX.Element {
  const lines = [
    ...pluginTrustWarnings(
      pluginTrust({ execution, points: pluginPointsFromManifest(preview.manifest) })
    ),
    ...reachablePluginCapabilities(preview.manifest.capabilities, execution).map((capability) =>
      pluginCapabilityDescription(capability.kind, capability.kind)
    )
  ]
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="group -ml-2 mt-1">
          {translate('auto.components.settings.PluginUpdateAllDialog.allAccess', 'See all access')}
          <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1.5 pt-1">
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {[...new Set(lines)].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <PluginConsentProvenance
            official={preview.official}
            publisher={preview.manifest.publisher}
            source={{
              kind: preview.bundled ? 'bundled' : 'marketplace',
              reference: sourceLabel({
                ...preview.source,
                url: `${preview.source.url}#${preview.source.ref}`
              }),
              resolvedCommit: preview.resolvedCommit,
              marketplace: {
                reference: preview.marketplaceName,
                resolvedCommit: preview.marketplaceCommit
              }
            }}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One line per plugin; only an update that needs approval opens up, and only to what's new. */
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
  const { capabilities: requestedAdded, warnings } = preview
    ? updateChanges(preview)
    : { capabilities: [], warnings: [] }
  const execution = preview ? pluginExecutionProfile(preview.manifest) : 'data'
  const added = requestedAdded.filter((kind) => pluginCapabilityReachable(kind, execution))
  const movedFrom = preview ? movedFromSource(entry, preview) : null
  const checkboxId = `plugin-update-${entry.pluginKey}`
  let note: React.ReactNode = null
  if (done) {
    note = (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden="true" />
        {translate('auto.components.settings.PluginUpdateAllDialog.updated', 'Updated')}
      </p>
    )
  } else if (error) {
    note = (
      <p className="text-xs text-destructive">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.previewError',
          'Couldn’t read this update'
        )}
      </p>
    )
  } else if (preview?.blockedByKillList) {
    note = (
      <p className="text-xs text-destructive">
        {translate(
          'auto.components.settings.PluginMarketplaceListingRow.blocked',
          "Blocked by Orca's safety list: {{value0}}",
          { value0: preview.blockedByKillList.reason }
        )}
      </p>
    )
  } else if (isCurrent(entry, preview)) {
    note = (
      <p className="text-xs text-muted-foreground">
        {translate('auto.components.settings.PluginUpdateAllDialog.current', 'Already installed')}
      </p>
    )
  } else if (needsOrca) {
    note = (
      <p className="text-xs text-status-warning-text">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.needsOrca',
          'Needs Orca {{value0}} or later',
          { value0: needsOrca }
        )}
      </p>
    )
  } else if (preview && (added.length > 0 || warnings.length > 0 || movedFrom !== null)) {
    note = (
      <>
        <ul className="space-y-0.5 text-xs">
          {movedFrom !== null ? (
            <li className="text-status-warning-text">
              {translate(
                'auto.components.settings.PluginUpdateAllDialog.sourceMoved',
                'New source: {{value0}} (was {{value1}})',
                { value0: sourceLabel(preview.source), value1: movedFrom }
              )}
            </li>
          ) : null}
          {warnings.map((warning) => (
            <NewLine key={warning}>{warning}</NewLine>
          ))}
          {added.map((kind) => (
            <NewLine key={kind}>{pluginCapabilityDescription(kind, kind)}</NewLine>
          ))}
        </ul>
        <AllAccess preview={preview} execution={execution} />
      </>
    )
  }
  return (
    <li data-plugin-update={entry.pluginKey} className="py-2">
      <div className="flex items-center gap-3">
        <PluginRowArt entry={entry} />
        <label htmlFor={checkboxId} className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry.name}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {entry.installed?.version} → {preview?.manifest.version ?? entry.updateVersion}
          </span>
        </label>
        <Checkbox
          id={checkboxId}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
      </div>
      {note ? <div className="mt-1 ml-10">{note}</div> : null}
    </li>
  )
}
