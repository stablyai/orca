import { Plus } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { useTranslate } from '@/i18n/use-translate'
import { Checkbox } from '../../ui/checkbox'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { PluginUpdatePublisher, PluginUpdateVersions } from './PluginUpdateIdentity'
import { AllAccess } from './PluginUpdateCandidate'
import { pluginUpdateAdditions } from './plugin-update-additions'

/** One "+" line per addition; shared by the review dialog and the toast. */
export function PluginUpdateAdditionList({
  lines,
  className = ''
}: {
  lines: readonly string[]
  className?: string
}): React.JSX.Element {
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {lines.map((line) => (
        <li key={line} data-added="" className="flex items-start gap-2">
          <Plus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One update that asks for more than the installed version. Why only the additions: what the
 * plugin could already do was approved before, and repeating it hides the one line that matters.
 * Everything else stays behind "See all access". `selection` puts it in a group the user approves
 * together; without it the dialog's own button approves it.
 */
export function PluginUpdateReview({
  entry,
  preview,
  installedManifest,
  selection
}: {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview
  installedManifest: PluginManifest | null
  selection?: { checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }
}): React.JSX.Element {
  const t = useTranslate()
  const installed = entry.installed
  const execution = pluginExecutionProfile(preview.manifest)
  const { lines, compared } = pluginUpdateAdditions(preview, installedManifest, t)
  const checkboxId = `plugin-update-approve-${entry.pluginKey}`

  return (
    <div data-plugin-update-review={entry.pluginKey} className="space-y-3">
      <div className="flex items-center gap-3">
        <PluginRowArt entry={entry} />
        <div className="min-w-0 flex-1 space-y-1">
          {/* Why the link outside the label: a click on it must not toggle the checkbox. */}
          <p className="flex min-w-0 items-baseline text-sm font-medium">
            {selection ? (
              <label htmlFor={checkboxId} className="truncate">
                {entry.name}
              </label>
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
            <PluginUpdateVersions from={installed?.version} preview={preview} />
          </p>
          <PluginUpdatePublisher pluginKey={entry.pluginKey} preview={preview} />
        </div>
        {selection ? (
          <Checkbox
            id={checkboxId}
            checked={selection.checked}
            disabled={selection.disabled}
            onCheckedChange={(next) => selection.onCheckedChange(next === true)}
          />
        ) : null}
      </div>
      {compared ? null : (
        <p className="text-sm text-muted-foreground">
          {t(
            'auto.components.settings.PluginUpdateReview.uncompared',
            'Orca couldn’t compare this version with the one you approved. Check what it can access before you update.'
          )}
        </p>
      )}
      {lines.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('auto.components.settings.PluginUpdateReview.newInVersion', 'New in this version:')}
          </p>
          <PluginUpdateAdditionList
            lines={lines}
            className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm"
          />
        </div>
      ) : null}
      <AllAccess preview={preview} execution={execution} defaultOpen={!compared} />
    </div>
  )
}
