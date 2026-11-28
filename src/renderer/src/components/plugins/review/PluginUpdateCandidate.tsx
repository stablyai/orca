import { pluginBlockCopy } from '../presentation/plugin-block-copy'
// @protected-copy
import { Check, ChevronDown } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { reachablePluginCapabilities } from '../../../../../shared/plugins/capabilities/plugin-capability-reach'
import { builtInActionTitle } from '../page/PluginCommandReplacementRow'
import type { PluginContributionPoint } from '../../../../../shared/plugins/contributions/plugin-contribution-points'
import { pluginUpdateGrowsAccess } from '../../../../../shared/plugins/approval/plugin-update-access-growth'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { PluginConsentProvenance } from './PluginConsentProvenance'
import { pluginKeyOwner } from './PluginUpdateIdentity'
import { pluginPointsFromManifest, pluginTrust } from '../presentation/plugin-access-profile'
import { pluginTrustWarnings } from '../presentation/plugin-consent-copy'
import { pluginCapabilityDescription } from '../presentation/plugin-capability-presentation'
import { editorGrowth, type EditorManifest } from './plugin-update-editor-growth'

export type UpdateCandidate = {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview | null
  error: boolean
  /** Oldest Orca the update runs on, when this Orca is older. */
  needsOrca: string | null
  /** Read with the preview, so a review's lines are complete before it can be approved. */
  installedManifest: PluginManifest | null
}

/**
 * Whether the update changes what the plugin may do or where it comes from. Such an update lands
 * only through "Approve & update", which approves exactly what the review showed. Why unknown
 * counts: main omits growth only when it could not compare against the installed version.
 */
export function updateNeedsApproval(preview: PluginMarketplaceHostInstallPreview): boolean {
  return (
    preview.repositoryMoved === true ||
    !preview.accessGrowth ||
    pluginUpdateGrowsAccess(preview.accessGrowth)
  )
}

// Why the same form as main's list projection: the Source popover shows it next to the commit.
const sourceLabel = (source: { url: string; path?: string }): string =>
  source.path ? `${source.url} (${source.path})` : source.url

const contributionGrowthLabel = (point: PluginContributionPoint, t: Translate): string => {
  if (point === 'keybindings') {
    return t('auto.components.settings.PluginUpdateAllDialog.newShortcuts', 'Keyboard shortcuts')
  }
  if (point === 'commands') {
    return t('auto.components.settings.PluginUpdateAllDialog.newCommands', 'Commands')
  }
  if (point === 'panels') {
    return t('auto.components.settings.PluginUpdateAllDialog.newPanels', 'Adds panels')
  }
  if (point === 'events') {
    return t(
      'auto.components.settings.PluginUpdateAllDialog.newEvents',
      'Reacts to more Orca events'
    )
  }
  if (point === 'vmRecipes') {
    return t('auto.components.settings.PluginUpdateAllDialog.newRecipes', 'Machine recipes')
  }
  if (point === 'mcpServers') {
    return t('auto.components.settings.PluginUpdateAllDialog.newMcpServers', 'MCP servers')
  }
  if (point === 'customEditors') {
    return t(
      'auto.components.settings.PluginUpdateAllDialog.newFileTypes',
      'Changes which files it opens'
    )
  }
  if (point === 'hooks') {
    return t(
      'auto.components.settings.PluginUpdateAllDialog.newHooks',
      'Can change or stop what Orca and your agents do'
    )
  }
  if (point === 'settings') {
    return t('auto.components.settings.PluginUpdateAllDialog.newSettings', 'A settings page')
  }
  if (point === 'composerItems') {
    return t('components.plugins.newComposerItems', 'Chat composer items')
  }
  if (point === 'statusBarItems') {
    return t('auto.components.settings.PluginUpdateAllDialog.newStatusBarItems', 'Status bar items')
  }
  return t(
    'auto.components.settings.PluginUpdateAllDialog.newContributions',
    'Features that act for you'
  )
}

function editorGrowthLines(
  installed: EditorManifest | null | undefined,
  next: EditorManifest,
  t: Translate
): string[] {
  // Why generic without the installed manifest: nothing to compare against yet.
  const growth = installed
    ? editorGrowth(installed, next)
    : { files: [], defaults: [], other: true }
  const lines = [
    ...(growth.files.length > 0
      ? [
          t(
            'auto.components.settings.PluginUpdateAllDialog.opensFileTypes',
            'Opens new file types: {{value0}}',
            { value0: growth.files.join(', ') }
          )
        ]
      : []),
    ...(growth.defaults.length > 0
      ? [
          t(
            'auto.components.settings.PluginUpdateAllDialog.becomesDefaultEditor',
            'Becomes the default editor for {{value0}}',
            { value0: growth.defaults.join(', ') }
          )
        ]
      : [])
  ]
  return growth.other || lines.length === 0
    ? [...lines, contributionGrowthLabel('customEditors', t)]
    : lines
}

const replacementLine = (command: string, action: string, t: Translate): string =>
  t(
    'auto.components.settings.PluginUpdateAllDialog.replacesAction',
    '{{value0}} runs instead of Orca’s {{value1}}',
    { value0: command, value1: builtInActionTitle(action) }
  )

/** What main found the update adds over the installed version, as review lines. */
export function updateChanges(
  preview: PluginMarketplaceHostInstallPreview,
  t: Translate,
  /** The installed manifest, when loaded: names the file types a grown editor reaches. */
  installedManifest?: EditorManifest | null
): {
  capabilities: string[]
  warnings: string[]
} {
  const growth = preview.accessGrowth
  const execution = growth?.execution
    ? pluginTrustWarnings(
        pluginTrust({
          execution: growth.execution,
          points: pluginPointsFromManifest(preview.manifest)
        }),
        t
      )
    : []
  // Why: a panel profile has no trust warning of its own, but its growth still asks again.
  const executionLines =
    growth?.execution && execution.length === 0 ? [contributionGrowthLabel('panels', t)] : execution
  const contributions = (growth?.contributions ?? []).flatMap((point) =>
    point === 'customEditors'
      ? editorGrowthLines(installedManifest, preview.manifest, t)
      : [contributionGrowthLabel(point, t)]
  )
  // Why named: "Commands" alone would hide that one takes over an Orca action.
  const replacements = growth?.contributions.includes('commands')
    ? preview.manifest.contributes.commands.flatMap((command) =>
        command.replaces ? [replacementLine(command.title, command.replaces, t)] : []
      )
    : []
  return {
    capabilities: growth?.capabilities ?? [],
    warnings: [...new Set([...executionLines, ...contributions, ...replacements])]
  }
}

export function isCurrent(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview | null
): boolean {
  return Boolean(preview && entry.installed?.source?.contentHash === preview.contentHash)
}

/** Everything the update can reach, for the rare reader who wants more than what's new. */
export function AllAccess({
  preview,
  execution,
  defaultOpen = false
}: {
  preview: PluginMarketplaceHostInstallPreview
  execution: ReturnType<typeof pluginExecutionProfile>
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const lines = [
    ...pluginTrustWarnings(
      pluginTrust({ execution, points: pluginPointsFromManifest(preview.manifest) }),
      t
    ),
    ...reachablePluginCapabilities(preview.manifest.capabilities, execution).map((capability) =>
      pluginCapabilityDescription(capability.kind, capability.kind, t)
    )
  ]
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="group -ml-2 mt-1">
          {t('auto.components.settings.PluginUpdateAllDialog.allAccess', 'See all access')}
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
            badge={false}
            official={preview.official}
            publisher={pluginKeyOwner(preview.pluginKey)}
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

/** One line per update that asks for nothing new, or that can't be installed and says why. */
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
  const t = useTranslate()
  const { entry, preview, error, needsOrca } = candidate
  const checkboxId = `plugin-update-${entry.pluginKey}`
  let note: React.ReactNode = null
  if (done) {
    note = (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden="true" />
        {t('auto.components.settings.PluginUpdateAllDialog.updated', 'Updated')}
      </p>
    )
  } else if (error) {
    note = (
      <p className="text-xs text-destructive">
        {t(
          'auto.components.settings.PluginUpdateAllDialog.previewError',
          'Couldn’t read this update'
        )}
      </p>
    )
  } else if (preview?.blockedByKillList) {
    note = (
      <p className="text-xs text-destructive">{pluginBlockCopy(preview.blockedByKillList, t)}</p>
    )
  } else if (isCurrent(entry, preview)) {
    note = (
      <p className="text-xs text-muted-foreground">
        {t('auto.components.settings.PluginUpdateAllDialog.current', 'Already installed')}
      </p>
    )
  } else if (needsOrca) {
    note = (
      <p className="text-xs text-status-warning-text">
        {t(
          'auto.components.settings.PluginUpdateAllDialog.needsOrca',
          'Needs Orca {{value0}} or later',
          { value0: needsOrca }
        )}
      </p>
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
