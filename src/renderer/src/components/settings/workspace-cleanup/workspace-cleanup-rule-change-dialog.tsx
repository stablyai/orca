import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatBytes } from '../../../../../shared/text/format-bytes'
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
import {
  WorkspaceCleanupWorkspaceLine,
  workspaceCleanupRowKey
} from './workspace-cleanup-workspace-line'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'

export type WorkspaceCleanupRuleChangeRequest = {
  /** `change`: a setting other than a rule switch, such as the inactive days, widened what is deleted. */
  kind: 'enable' | 'change' | 'disable-ignored-files'
  ruleTitle: string
  rows: WorkspaceCleanupPreviewRow[]
}

/** Reviews newly eligible workspaces or removing ignored-file protection before saving. */
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
  const disablingProtection = shownRequest?.kind === 'disable-ignored-files'
  const enabling = shownRequest?.kind === 'enable'
  const deleted = rows.filter((row) => !kept.has(workspaceCleanupRowKey(row)))
  const deletedBytes = deleted.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)

  const toggleKeep = (row: WorkspaceCleanupPreviewRow): void => {
    setKept((previous) => {
      const next = new Set(previous)
      if (!next.delete(workspaceCleanupRowKey(row))) {
        next.add(workspaceCleanupRowKey(row))
      }
      return next
    })
  }

  const confirm = (): void => {
    setConfirming(true)
    void onConfirm(rows.filter((row) => kept.has(workspaceCleanupRowKey(row)))).finally(() =>
      setConfirming(false)
    )
  }

  return (
    <Dialog
      open={request !== null}
      // Pins may already be written; backing out mid-confirm would leave the change half done.
      onOpenChange={(open) => (!open && !confirming ? onCancel() : undefined)}
    >
      <DialogContent
        surface="security"
        {...(disablingProtection
          ? { 'aria-describedby': 'cleanup-protection-risk cleanup-protection-consequences' }
          : {})}
        showCloseButton={!confirming}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {disablingProtection
              ? t(
                  'components.settings.workspaceCleanup.disableIgnoredFiles.title',
                  'Turn off ignored-file protection?'
                )
              : enabling
                ? t('components.settings.workspaceCleanup.enable.title', 'Turn on {{rule}}?', {
                    rule: shownRequest?.ruleTitle ?? ''
                  })
                : t('components.settings.workspaceCleanup.change.title', 'Change {{rule}}?', {
                    rule: shownRequest?.ruleTitle ?? ''
                  })}
          </DialogTitle>
          {disablingProtection ? (
            <p id="cleanup-protection-risk" className="text-sm text-muted-foreground">
              {t(
                'components.settings.workspaceCleanup.disableIgnoredFiles.description',
                'For projects using these cleanup rules, ignored files will no longer prevent automatic cleanup. Files such as .env and local config may be deleted and cannot be recovered.'
              )}
            </p>
          ) : null}
          {!disablingProtection || rows.length > 0 ? (
            <DialogDescription
              {...(disablingProtection ? { id: 'cleanup-protection-consequences' } : {})}
            >
              {disablingProtection
                ? t(
                    'components.settings.workspaceCleanup.disableIgnoredFiles.matches',
                    'Without pinning, {{count}} additional workspaces will be deleted a few seconds after you turn off protection.',
                    {
                      count: rows.length,
                      defaultValue_one:
                        'Without pinning, {{count}} additional workspace will be deleted a few seconds after you turn off protection.'
                    }
                  )
                : enabling
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
          ) : (
            <DialogDescription
              {...(disablingProtection ? { id: 'cleanup-protection-consequences' } : {})}
            >
              {t(
                'components.settings.workspaceCleanup.disableIgnoredFiles.noMatches',
                'No additional workspaces match right now. This setting affects future cleanup in projects using these rules.'
              )}
            </DialogDescription>
          )}
        </DialogHeader>
        {rows.length > 0 ? (
          <p id="cleanup-pin-note" className="text-xs text-muted-foreground">
            {t(
              'components.settings.workspaceCleanup.pinAndKeep.description',
              'Selected workspaces will be pinned when you confirm. Pinned workspaces are excluded from automatic cleanup until you unpin them.'
            )}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div
            role="list"
            className="max-h-72 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 scrollbar-sleek"
          >
            {rows.map((row, index) => {
              const keep = kept.has(workspaceCleanupRowKey(row))
              return (
                <div
                  key={workspaceCleanupRowKey(row)}
                  role="listitem"
                  className={cn(
                    'flex min-w-0 flex-wrap items-center gap-3 py-2',
                    index < rows.length - 1 && 'border-b border-border/50'
                  )}
                >
                  <WorkspaceCleanupWorkspaceLine workspace={row} className="flex-1" />
                  {row.evaluation.action !== 'keep' ? (
                    <WorkspaceCleanupReasonChip
                      reason={row.evaluation.reason}
                      prNumber={row.prNumber}
                    />
                  ) : null}
                  <span
                    className={cn(
                      'w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground',
                      keep && 'line-through decoration-muted-foreground/70'
                    )}
                  >
                    {row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : null}
                  </span>
                  <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground max-sm:basis-full max-sm:justify-end">
                    <Checkbox
                      aria-describedby="cleanup-pin-note"
                      checked={keep}
                      disabled={confirming}
                      onCheckedChange={() => toggleKeep(row)}
                      aria-label={t(
                        'components.settings.workspaceCleanup.pinAndKeep.named',
                        'Pin and keep {{name}}',
                        {
                          name: row.displayName
                        }
                      )}
                    />
                    {t('components.settings.workspaceCleanup.pinAndKeep.label', 'Pin and keep')}
                  </label>
                </div>
              )
            })}
          </div>
        ) : null}
        <DialogFooter className="items-center">
          {rows.length > 0 ? (
            <p className="mr-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {t(
                'components.settings.workspaceCleanup.enable.summary',
                '{{count}} will be deleted',
                {
                  count: deleted.length
                }
              )}
              {deletedBytes > 0 ? ` · ${formatBytes(deletedBytes)}` : null}
            </p>
          ) : null}
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
          </Button>
          <Button
            variant={disablingProtection ? 'destructive' : 'default'}
            onClick={confirm}
            disabled={confirming}
          >
            {disablingProtection
              ? t(
                  'components.settings.workspaceCleanup.disableIgnoredFiles.turnOff',
                  'Turn off protection'
                )
              : enabling
                ? t('components.settings.workspaceCleanup.enable.turnOn', 'Turn on')
                : t('components.settings.workspaceCleanup.change.apply', 'Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
