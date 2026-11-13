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

export type WorkspaceCleanupEnableRuleRequest = {
  ruleTitle: string
  rows: WorkspaceCleanupPreviewRow[]
}

function rowKey(row: WorkspaceCleanupPreviewRow): string {
  return `${row.executionHostId ?? ''}:${row.worktreeId}`
}

/** Shown before a delete rule turns on while it matches workspaces; Keep pins a workspace so it is never removed. */
export function WorkspaceCleanupEnableRuleDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: WorkspaceCleanupEnableRuleRequest | null
  onCancel: () => void
  onConfirm: (keep: WorkspaceCleanupPreviewRow[]) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [shownRequest, setShownRequest] = useState(request)
  if (request !== shownRequest) {
    setShownRequest(request)
    setKept(new Set())
  }
  const rows = request?.rows ?? []
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
    <Dialog open={request !== null} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('components.settings.workspaceCleanup.enable.title', 'Turn on {{rule}}?', {
              rule: request?.ruleTitle ?? ''
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.settings.workspaceCleanup.enable.description',
              "{{count}} workspaces match right now. They'll be deleted a few seconds after you turn this on.",
              {
                count: rows.length,
                defaultValue_one:
                  "1 workspace matches right now. It'll be deleted a few seconds after you turn this on."
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
          <Button variant="outline" onClick={onCancel} disabled={confirming}>
            {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
          </Button>
          <Button onClick={confirm} disabled={confirming}>
            {t('components.settings.workspaceCleanup.enable.turnOn', 'Turn on')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
