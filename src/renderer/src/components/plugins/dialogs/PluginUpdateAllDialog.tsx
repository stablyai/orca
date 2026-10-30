import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api-types'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import {
  CandidateRow,
  isCurrent,
  updateNeedsApproval,
  type UpdateCandidate
} from '../review/PluginUpdateCandidate'
import { PluginUpdateReview } from '../review/PluginUpdateReview'
import type { PluginListEntry } from '../list/plugin-list-entries'

/** Updates that change access or repository; they land only through their own review. */
function needsOwnApproval(candidate: UpdateCandidate): boolean {
  return candidate.preview !== null && updateNeedsApproval(candidate.preview)
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
 * One review for every pending update. Updates that ask for nothing new are one ticked line;
 * any can be unticked and nothing installs until Update. An update that grows access or moved
 * repository never joins that bulk Update: its Review opens its own before/after approval.
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
  const [reviewKey, setReviewKey] = useState<string | null>(null)
  // Why frozen: each update reloads the list mid-run; the rows belong to the set the user opened.
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
        // Why straight to review: a lone update that needs approval has nothing else to show.
        const [only] = next
        if (next.length === 1 && only.preview && needsOwnApproval(only)) {
          setReviewKey(only.entry.pluginKey)
        }
      }
    })
    return () => {
      stale = true
    }
  }, [open, plugins])

  const installable = (candidate: UpdateCandidate): boolean =>
    Boolean(candidate.preview) &&
    !candidate.preview?.blockedByKillList &&
    !isCurrent(candidate.entry, candidate.preview) &&
    !candidate.needsOrca &&
    !updated.has(candidate.entry.pluginKey)
  const chosen = (candidates ?? []).filter(
    (candidate) =>
      installable(candidate) &&
      !needsOwnApproval(candidate) &&
      !skipped.has(candidate.entry.pluginKey)
  )
  const reviewing =
    candidates?.find(
      (candidate) => candidate.entry.pluginKey === reviewKey && installable(candidate)
    ) ?? null
  const leaveReview = (): void => {
    setFailure(null)
    if (plugins.length === 1) {
      onClose()
    } else {
      setReviewKey(null)
    }
  }
  /** Installs the reviewed release, then approves exactly the fingerprint this dialog showed. */
  const approveReviewed = async ({ entry, preview }: UpdateCandidate): Promise<void> => {
    if (!preview) {
      return
    }
    setBusy(true)
    setFailure(null)
    let ok = false
    try {
      const result = await window.api.plugins.installMarketplacePlugin({
        marketplaceSourceId: preview.marketplaceSourceId,
        marketplaceCommit: preview.marketplaceCommit,
        pluginKey: preview.pluginKey,
        resolvedCommit: preview.resolvedCommit
      })
      ok = result.ok
      // Why only on a match: other bytes than the reviewed ones wait for review on the page.
      if (result.ok && result.consentFingerprint === preview.consentFingerprint) {
        await window.api.plugins.consent({
          pluginKey: preview.pluginKey,
          reviewedFingerprint: preview.consentFingerprint,
          decision: 'approve'
        })
      }
    } catch (cause) {
      console.warn('[plugins] reviewed update failed:', cause)
    }
    if (ok) {
      setUpdated((current) => new Set([...current, entry.pluginKey]))
      await onUpdated([entry.pluginKey])
    }
    setBusy(false)
    if (ok) {
      leaveReview()
      return
    }
    setFailure(failureMessage([entry.name], updated.size))
  }
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
      <DialogContent surface="security" scrollable aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {reviewing
              ? translate(
                  'auto.components.settings.PluginUpdateReview.title',
                  'Review update to {{value0}}',
                  { value0: reviewing.entry.name }
                )
              : plugins.length === 1
                ? translate(
                    'auto.components.settings.PluginUpdateAllDialog.updateOne',
                    'Update 1 plugin'
                  )
                : translate(
                    'auto.components.settings.PluginUpdateAllDialog.updateMany',
                    'Update {{value0}} plugins',
                    { value0: plugins.length }
                  )}
          </DialogTitle>
        </DialogHeader>
        {candidates === null ? (
          <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />
        ) : reviewing?.preview ? (
          <PluginUpdateReview entry={reviewing.entry} preview={reviewing.preview} />
        ) : (
          <ul className="divide-y divide-border">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.entry.pluginKey}
                candidate={candidate}
                done={updated.has(candidate.entry.pluginKey)}
                checked={installable(candidate) && !skipped.has(candidate.entry.pluginKey)}
                disabled={!installable(candidate) || busy}
                onReview={
                  needsOwnApproval(candidate)
                    ? () => {
                        setFailure(null)
                        setReviewKey(candidate.entry.pluginKey)
                      }
                    : undefined
                }
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
        {reviewing ? (
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={leaveReview}>
              {plugins.length === 1
                ? translate('auto.components.settings.PluginUpdateAllDialog.cancel', 'Cancel')
                : translate('auto.components.settings.PluginUpdateReview.back', 'Back')}
            </Button>
            <Button disabled={busy} onClick={() => void approveReviewed(reviewing)}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {translate('auto.components.settings.PluginUpdateReview.approve', 'Approve & update')}
            </Button>
          </DialogFooter>
        ) : (
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
                : translate('auto.components.settings.PluginUpdateAllDialog.update', 'Update')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
