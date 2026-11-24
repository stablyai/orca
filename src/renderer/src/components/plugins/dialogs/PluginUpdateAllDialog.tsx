import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import {
  CandidateRow,
  isCurrent,
  updateNeedsApproval,
  type UpdateCandidate
} from '../review/PluginUpdateCandidate'
import { PluginUpdateReview } from '../review/PluginUpdateReview'
import { installUpdates, loadUpdate, requiredNewerOrca } from '../state/plugin-update-approval'
import type { PluginListEntry } from '../list/plugin-list-entries'

/** Updates that change access or repository; they land only through their own review. */
function needsOwnApproval(candidate: UpdateCandidate): boolean {
  return candidate.preview !== null && updateNeedsApproval(candidate.preview)
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
 * One review for every pending update. Updates that ask for nothing new are one ticked line.
 * Updates that grow access or moved repository are grouped above them, each showing only what it
 * adds; the button then reads "Approve & update" and approves exactly what was shown. Beside plain
 * updates those start unticked, so a grant takes a deliberate tick. A lone one shows alone.
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
  const t = useTranslate()
  const [candidates, setCandidates] = useState<UpdateCandidate[] | null>(null)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const [updated, setUpdated] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
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
          const { preview, installedManifest } = await loadUpdate(entry.pluginKey)
          return {
            entry,
            preview,
            error: false,
            needsOrca: requiredNewerOrca(preview, orcaVersionRef.current),
            installedManifest
          }
        } catch (cause) {
          console.warn('[plugins] update preview failed:', cause)
          return { entry, preview: null, error: true, needsOrca: null, installedManifest: null }
        }
      })
    ).then((next) => {
      if (!stale) {
        setCandidates(next)
        // Why unticked beside plain updates: those tick by default, and a grant needs a deliberate yes.
        if (next.some((candidate) => !needsOwnApproval(candidate))) {
          setSkipped(
            new Set(next.filter(needsOwnApproval).map((candidate) => candidate.entry.pluginKey))
          )
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
  const approvals = (candidates ?? []).filter(
    (candidate) => installable(candidate) && needsOwnApproval(candidate)
  )
  const rows = (candidates ?? []).filter((candidate) => !approvals.includes(candidate))
  const picked = (candidate: UpdateCandidate): boolean =>
    installable(candidate) && !skipped.has(candidate.entry.pluginKey)
  const chosen = (candidates ?? []).filter(picked)
  const approving = approvals.some(picked)
  const alone = approvals.length === 1 && rows.length === 0 ? approvals[0] : null
  const setPicked = (pluginKey: string, checked: boolean): void =>
    setSkipped((current) => {
      const next = new Set(current)
      if (checked) {
        next.delete(pluginKey)
      } else {
        next.add(pluginKey)
      }
      return next
    })

  const update = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const { approved, held, failed } = await installUpdates(
      chosen.flatMap(({ entry, preview }) =>
        preview
          ? [
              {
                preview,
                name: entry.name,
                reviewed: approvals.some((item) => item.entry === entry)
              }
            ]
          : []
      )
    )
    const done = [...approved, ...held].map(({ preview }) => preview.pluginKey)
    setUpdated((current) => new Set([...current, ...done]))
    if (done.length > 0) {
      await onUpdated(done)
    }
    setBusy(false)
    if (failed.length === 0) {
      onClose()
      return
    }
    setFailure(
      failureMessage(
        failed.map(({ name }) => name),
        updated.size + done.length
      )
    )
  }

  const title = alone
    ? t('auto.components.settings.PluginUpdateReview.title', 'Review update to {{value0}}', {
        value0: alone.entry.name
      })
    : rows.length === 0 && approvals.length > 1
      ? t('auto.components.settings.PluginUpdateReview.titleMany', 'Review {{value0}} updates', {
          value0: approvals.length
        })
      : plugins.length === 1
        ? t('auto.components.settings.PluginUpdateAllDialog.updateOne', 'Update 1 plugin')
        : t(
            'auto.components.settings.PluginUpdateAllDialog.updateMany',
            'Update {{value0}} plugins',
            {
              value0: plugins.length
            }
          )
  const grouped = approvals.length > 0 && rows.length > 0

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent surface="security" scrollable aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {candidates === null ? (
          <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />
        ) : alone?.preview ? (
          <PluginUpdateReview
            entry={alone.entry}
            preview={alone.preview}
            installedManifest={alone.installedManifest}
          />
        ) : (
          <div className="space-y-4">
            {approvals.length > 0 ? (
              <section className="space-y-2">
                {grouped ? (
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t(
                      'auto.components.settings.PluginUpdateAllDialog.needApproval',
                      'Need your approval'
                    )}
                  </h3>
                ) : null}
                <div className="divide-y divide-border">
                  {approvals.map((candidate) =>
                    candidate.preview ? (
                      <div key={candidate.entry.pluginKey} className="py-3 first:pt-0">
                        <PluginUpdateReview
                          entry={candidate.entry}
                          preview={candidate.preview}
                          installedManifest={candidate.installedManifest}
                          selection={{
                            checked: picked(candidate),
                            disabled: busy,
                            onCheckedChange: (checked) =>
                              setPicked(candidate.entry.pluginKey, checked)
                          }}
                        />
                      </div>
                    ) : null
                  )}
                </div>
              </section>
            ) : null}
            {rows.length > 0 ? (
              <section className="space-y-1">
                {grouped ? (
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t(
                      'auto.components.settings.PluginUpdateAllDialog.readyToUpdate',
                      'Ready to update'
                    )}
                  </h3>
                ) : null}
                <ul className="divide-y divide-border">
                  {rows.map((candidate) => (
                    <CandidateRow
                      key={candidate.entry.pluginKey}
                      candidate={candidate}
                      done={updated.has(candidate.entry.pluginKey)}
                      checked={picked(candidate)}
                      disabled={!installable(candidate) || busy}
                      onCheckedChange={(checked) => setPicked(candidate.entry.pluginKey, checked)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
        {failure ? (
          <p role="alert" className="text-xs text-destructive">
            {failure}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {updated.size > 0
              ? t('auto.components.settings.PluginUpdateAllDialog.close', 'Close')
              : t('auto.components.settings.PluginUpdateAllDialog.cancel', 'Cancel')}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void update()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {failure
              ? t('auto.components.settings.PluginUpdateAllDialog.retry', 'Try again')
              : approving
                ? t('auto.components.settings.PluginUpdateReview.approve', 'Approve & update')
                : t('auto.components.settings.PluginUpdateAllDialog.update', 'Update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
