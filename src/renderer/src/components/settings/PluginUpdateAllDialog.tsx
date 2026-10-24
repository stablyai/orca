import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
import { satisfiesOrcaEngineRange } from '../../../../shared/plugins/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import { pluginCapabilityDescription } from './plugin-capability-presentation'

type UpdateCandidate = {
  entry: PluginListEntry
  preview: PluginMarketplaceHostInstallPreview | null
  error: boolean
  /** Oldest Orca the update runs on, when this Orca is older. */
  needsOrca: string | null
}

/** Capabilities the update asks for that the installed version doesn't have. */
export function newAccess(
  entry: PluginListEntry,
  preview: PluginMarketplaceHostInstallPreview
): string[] {
  const held = new Set(entry.installed?.capabilities.map((capability) => capability.kind) ?? [])
  return preview.manifest.capabilities
    .map((capability) => capability.kind)
    .filter((kind) => !held.has(kind))
}

/** The update's minimum Orca when this Orca can't run it; null when it can or either is unknown. */
function requiredNewerOrca(
  preview: PluginMarketplaceHostInstallPreview,
  orcaVersion: string | null | undefined
): string | null {
  const range = preview.manifest.engines?.orca
  if (!range || !orcaVersion || satisfiesOrcaEngineRange(orcaVersion, range)) {
    return null
  }
  return range.replace(/^>=/, '')
}

function failureMessage(failed: readonly string[], updatedCount: number): string {
  return updatedCount === 0
    ? translate(
        'auto.components.settings.PluginUpdateAllDialog.failedAll',
        'Couldn’t update {{value0}}. Nothing was updated.',
        { value0: failed.join(', ') }
      )
    : translate(
        'auto.components.settings.PluginUpdateAllDialog.failed',
        'Couldn’t update {{value0}}. The others were updated.',
        { value0: failed.join(', ') }
      )
}

/**
 * One review for every pending update. Plugins whose access grows are expanded with what's new;
 * the rest are one line. Any can be unticked; nothing installs until Update.
 * Why no reset effect: the parent mounts a fresh dialog per open (keyed), so state starts clean.
 */
export function PluginUpdateAllDialog({
  open,
  entries,
  orcaVersion,
  onClose,
  onUpdated
}: {
  open: boolean
  entries: readonly PluginListEntry[]
  orcaVersion?: string | null
  onClose: () => void
  onUpdated: (pluginKeys: string[]) => Promise<void>
}): React.JSX.Element {
  const [candidates, setCandidates] = useState<UpdateCandidate[] | null>(null)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const [updated, setUpdated] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Why frozen: each update reloads the list mid-run; previews (git clones) and "Updated" rows
  // belong to the set the user opened, and the parent mounts a fresh dialog per open.
  const [plugins] = useState(entries)
  const orcaVersionRef = useRef(orcaVersion)
  useLayoutEffect(() => {
    orcaVersionRef.current = orcaVersion
  })

  useEffect(() => {
    if (!open) {
      return
    }
    let stale = false
    void Promise.all(
      plugins.map(async (entry): Promise<UpdateCandidate> => {
        try {
          const preview = await window.api.plugins.previewMarketplaceUpdate({
            pluginKey: entry.pluginKey
          })
          return {
            entry,
            preview,
            error: false,
            needsOrca: requiredNewerOrca(preview, orcaVersionRef.current)
          }
        } catch (cause) {
          console.warn('[plugins] update preview failed:', cause)
          return { entry, preview: null, error: true, needsOrca: null }
        }
      })
    ).then((next) => {
      if (!stale) {
        setCandidates(next)
      }
    })
    return () => {
      stale = true
    }
  }, [open, plugins])

  const installable = (candidate: UpdateCandidate): boolean =>
    Boolean(candidate.preview) && !candidate.needsOrca && !updated.has(candidate.entry.pluginKey)
  const chosen = (candidates ?? []).filter(
    (candidate) => installable(candidate) && !skipped.has(candidate.entry.pluginKey)
  )
  const growing = (candidates ?? []).filter(
    (candidate) => candidate.preview && newAccess(candidate.entry, candidate.preview).length > 0
  ).length

  const update = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const done: string[] = []
    const failed: string[] = []
    // Why sequential: each install re-reads the plugin list; parallel installs race that refresh.
    for (const { entry, preview } of chosen) {
      if (!preview) {
        continue
      }
      try {
        const result = await window.api.plugins.installMarketplacePlugin({
          marketplaceSourceId: preview.marketplaceSourceId,
          marketplaceCommit: preview.marketplaceCommit,
          pluginKey: preview.pluginKey,
          resolvedCommit: preview.resolvedCommit
        })
        if (result.ok) {
          done.push(entry.pluginKey)
        } else {
          failed.push(entry.name)
        }
      } catch (cause) {
        console.warn('[plugins] update failed:', cause)
        failed.push(entry.name)
      }
    }
    setUpdated((current) => new Set([...current, ...done]))
    if (done.length > 0) {
      await onUpdated(done)
    }
    setBusy(false)
    if (failed.length === 0) {
      onClose()
      return
    }
    setFailure(failureMessage(failed, updated.size + done.length))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent surface="security" scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.PluginUpdateAllDialog.title', 'Update plugins?')}
          </DialogTitle>
          <DialogDescription>
            {candidates === null
              ? translate(
                  'auto.components.settings.PluginUpdateAllDialog.reading',
                  'Reading what each update changes…'
                )
              : growing > 0
                ? translate(
                    'auto.components.settings.PluginUpdateAllDialog.someGrow',
                    'Updates that ask for new access are expanded below. The others change only what they add.'
                  )
                : translate(
                    'auto.components.settings.PluginUpdateAllDialog.noneGrow',
                    'None of these updates asks for new access.'
                  )}
          </DialogDescription>
        </DialogHeader>
        {candidates === null ? (
          <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />
        ) : (
          <ul className="divide-y divide-border">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.entry.pluginKey}
                candidate={candidate}
                done={updated.has(candidate.entry.pluginKey)}
                checked={installable(candidate) && !skipped.has(candidate.entry.pluginKey)}
                disabled={!installable(candidate) || busy}
                onCheckedChange={(checked) =>
                  setSkipped((current) => {
                    const next = new Set(current)
                    if (checked) {
                      next.delete(candidate.entry.pluginKey)
                    } else {
                      next.add(candidate.entry.pluginKey)
                    }
                    return next
                  })
                }
              />
            ))}
          </ul>
        )}
        {failure ? (
          <p role="alert" className="text-xs text-destructive">
            {failure}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {updated.size > 0
              ? translate('auto.components.settings.PluginUpdateAllDialog.close', 'Close')
              : translate('auto.components.settings.PluginUpdateAllDialog.cancel', 'Cancel')}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void update()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {failure
              ? translate('auto.components.settings.PluginUpdateAllDialog.retry', 'Try again')
              : chosen.length === 1
                ? translate(
                    'auto.components.settings.PluginUpdateAllDialog.updateOne',
                    'Update 1 plugin'
                  )
                : translate(
                    'auto.components.settings.PluginUpdateAllDialog.updateMany',
                    'Update {{value0}} plugins',
                    { value0: chosen.length }
                  )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CandidateRow({
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
  const added = preview ? newAccess(entry, preview) : []
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
  } else if (needsOrca) {
    note = (
      <p className="mt-0.5 text-xs text-status-warning">
        {translate(
          'auto.components.settings.PluginUpdateAllDialog.needsOrca',
          'Needs Orca {{value0}} or later. Update Orca first.',
          { value0: needsOrca }
        )}
      </p>
    )
  } else if (added.length > 0) {
    note = (
      <ul className="mt-1.5 space-y-0.5 border-l-2 border-status-warning pl-2 text-xs">
        {added.map((kind) => (
          <li key={kind} className="text-status-warning">
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
