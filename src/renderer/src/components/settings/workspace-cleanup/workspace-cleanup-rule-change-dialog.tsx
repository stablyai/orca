import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatBytes } from '../../../../../shared/format-bytes'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { WorkspaceCleanupWorkspaceLine } from './workspace-cleanup-workspace-line'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'

export type WorkspaceCleanupRuleChangeRequest = {
  /** `change`: a setting other than a rule switch, such as the inactive days, widened what is deleted. */
  kind: 'enable' | 'change'
  ruleTitle: string
  rows: WorkspaceCleanupPreviewRow[]
}

function rowKey(row: WorkspaceCleanupPreviewRow): string {
  return `${row.executionHostId ?? ''}:${row.worktreeId}`
}

/** Shown before a rule change that would delete workspaces right now; Keep pins a workspace so it is never removed. */
export function WorkspaceCleanupRuleChangeDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: WorkspaceCleanupRuleChangeRequest | null
  onCancel: () => void
  onConfirm: (keep: WorkspaceCleanupPreviewRow[]) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  // The last request stays on screen while the dialog animates out.
  const [shownRequest, setShownRequest] = useState(request)
  if (request && request !== shownRequest) {
    setShownRequest(request)
    setKept(new Set())
  }
  const rows = shownRequest?.rows ?? []
  const enabling = shownRequest?.kind !== 'change'
  const deleted = rows.filter((row) => !kept.has(rowKey(row)))
  const deletedBytes = deleted.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)

  const toggleKeep = (row: WorkspaceCleanupPreviewRow): void => {
    setKept((previous) => {
      const next = new Set(previous)
      if (!next.delete(rowKey(row))) {
        next.add(rowKey(row))
      }
      return next
    })
  }

  const confirm = (): void => {
    setConfirming(true)
    void onConfirm(rows.filter((row) => kept.has(rowKey(row)))).finally(() => setConfirming(false))
  }

  return (
    <Dialog
      open={request !== null}
      // Pins may already be written; backing out mid-confirm would leave the change half done.
      onOpenChange={(open) => (!open && !confirming ? onCancel() : undefined)}
    >
      <DialogContent surface="security" showCloseButton={!confirming} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {enabling
              ? t('components.settings.workspaceCleanup.enable.title', 'Turn on {{rule}}?', {
                  rule: shownRequest?.ruleTitle ?? ''
                })
              : t('components.settings.workspaceCleanup.change.title', 'Change {{rule}}?', {
                  rule: shownRequest?.ruleTitle ?? ''
                })}
          </DialogTitle>
          <DialogDescription>
            {enabling
              ? t(
                  'components.settings.workspaceCleanup.enable.description',
                  "{{count}} workspaces match right now. They'll be deleted a few seconds after you turn this on.",
                  {
                    count: rows.length,
                    defaultValue_one:
                      "1 workspace matches right now. It'll be deleted a few seconds after you turn this on."
                  }
                )
              : t(
                  'components.settings.workspaceCleanup.change.description',
                  "This change makes {{count}} more workspaces match right now. They'll be deleted a few seconds after you apply it.",
                  {
                    count: rows.length,
                    defaultValue_one:
                      "This change makes 1 more workspace match right now. It'll be deleted a few seconds after you apply it."
                  }
                )}
          </DialogDescription>
        </DialogHeader>
        <div
          role="list"
          className="max-h-72 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 scrollbar-sleek"
        >
          {rows.map((row, index) => {
            const keep = kept.has(rowKey(row))
            return (
              <div
                key={rowKey(row)}
                role="listitem"
                className={cn(
                  'flex min-w-0 items-center gap-3 py-2',
                  index < rows.length - 1 && 'border-b border-border/50'
                )}
              >
                <WorkspaceCleanupWorkspaceLine workspace={row} className="flex-1" />
                {row.evaluation.action !== 'keep' ? (
                  <WorkspaceCleanupReasonChip reason={row.evaluation.reason} />
                ) : null}
                <span
                  className={cn(
                    'w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground',
                    keep && 'line-through decoration-muted-foreground/70'
                  )}
                >
                  {row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : null}
                </span>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={keep}
                    onCheckedChange={() => toggleKeep(row)}
                    aria-label={t(
                      'components.settings.workspaceCleanup.enable.keepNamed',
                      'Keep {{name}}',
                      {
                        name: row.displayName
                      }
                    )}
                  />
                  {t('components.settings.workspaceCleanup.enable.keep', 'Keep')}
                </label>
              </div>
            )
          })}
        </div>
        <DialogFooter className="items-center">
          <p className="mr-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {t('components.settings.workspaceCleanup.enable.summary', '{{count}} will be deleted', {
              count: deleted.length
            })}
            {deletedBytes > 0 ? ` · ${formatBytes(deletedBytes)}` : null}
          </p>
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
          </Button>
          <Button onClick={confirm} disabled={confirming}>
            {enabling
              ? t('components.settings.workspaceCleanup.enable.turnOn', 'Turn on')
              : t('components.settings.workspaceCleanup.change.apply', 'Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
