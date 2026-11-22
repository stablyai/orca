// @protected-copy
import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import { Checkbox } from '../../ui/checkbox'
import { WorkspaceCleanupWorkspaceLine } from './workspace-cleanup-workspace-line'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'
import { cleanupChangeRowKey } from './workspace-cleanup-row-key'

export function WorkspaceCleanupRuleChangeRow({
  row,
  keep,
  isNew,
  project,
  position,
  total,
  disabled,
  pinLabel,
  onToggleKeep,
  onFocus
}: {
  row: WorkspaceCleanupPreviewRow
  keep: boolean
  isNew: boolean
  project: boolean
  position: number | undefined
  total: number
  disabled: boolean
  pinLabel: boolean
  onToggleKeep: (row: WorkspaceCleanupPreviewRow) => void
  onFocus: (key: string) => void
}) {
  const t = useTranslate()
  const newId = useId()
  const key = cleanupChangeRowKey(row)
  return (
    <div
      role="listitem"
      aria-setsize={total}
      aria-posinset={position}
      aria-label={row.displayName}
      className="flex min-w-0 items-center gap-2 border-b border-border py-2"
    >
      {isNew ? (
        <span id={newId} className="shrink-0 rounded-full border border-border px-1.5 text-xs">
          {t('components.settings.workspaceCleanup.change.new', 'New')}
        </span>
      ) : null}
      <WorkspaceCleanupWorkspaceLine workspace={row} hideProject={project} className="flex-1" />
      {row.evaluation.action !== 'keep' ? (
        <span className="hidden sm:inline-flex">
          <WorkspaceCleanupReasonChip reason={row.evaluation.reason} prNumber={row.prNumber} />
        </span>
      ) : null}
      {row.sizeBytes !== undefined ? (
        <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
          {formatBytes(row.sizeBytes)}
        </span>
      ) : null}
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          data-keep-key={key}
          checked={keep}
          disabled={disabled}
          aria-describedby={isNew ? newId : undefined}
          onFocus={() => onFocus(key)}
          onCheckedChange={() => onToggleKeep(row)}
          aria-label={
            pinLabel
              ? t(
                  'components.settings.workspaceCleanup.pinAndKeep.named',
                  'Pin and keep {{name}}',
                  { name: row.displayName }
                )
              : t('components.settings.workspaceCleanup.enable.keepNamed', 'Keep {{name}}', {
                  name: row.displayName
                })
          }
        />
        {pinLabel
          ? t('components.settings.workspaceCleanup.pinAndKeep.label', 'Pin and keep')
          : t('components.settings.workspaceCleanup.enable.keep', 'Keep')}
      </label>
    </div>
  )
}
