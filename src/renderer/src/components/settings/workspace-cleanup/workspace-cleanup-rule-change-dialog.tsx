import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
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
import { VirtualizedList } from '../../ui/virtualized-list'
import { WorkspaceCleanupWorkspaceLine } from './workspace-cleanup-workspace-line'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'
import { cleanupChangeRowKey, cleanupExistingRuleNotice } from './workspace-cleanup-change-preview'
import {
  workspaceCleanupConfirmedSettingTitle,
  type WorkspaceCleanupConfirmedSetting
} from './workspace-cleanup-confirmed-setting'

export type WorkspaceCleanupRuleChangeRequest = {
  kind: 'enable' | 'change' | 'inherit' | 'disable-ignored-files'
  setting: WorkspaceCleanupConfirmedSetting
  projectName?: string
  rows: WorkspaceCleanupPreviewRow[]
  newKeys: ReadonlySet<string>
  currentKeys: ReadonlySet<string>
  kept: ReadonlySet<string>
  keepRefs?: ReadonlyMap<string, WorkspaceCleanupPreviewRow>
  status: { added: number; deleted: string[] } | null
}

export function WorkspaceCleanupRuleChangeDialog({
  request,
  onCancel,
  onConfirm,
  onToggleKeep,
  confirming = false,
  settling = false,
  error,
  onRetry,
  onCloseAutoFocus
}: {
  request: WorkspaceCleanupRuleChangeRequest | null
  onCancel: () => void
  onConfirm: () => Promise<void>
  onToggleKeep: (row: WorkspaceCleanupPreviewRow) => void
  confirming?: boolean
  settling?: boolean
  error?: string | null
  onRetry?: () => void
  onCloseAutoFocus?: (event: Event) => void
}): React.JSX.Element {
  const t = useTranslate()
  const status = useRef<HTMLDivElement>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [activeKey, setActiveKey] = useState<string>()
  useEffect(() => {
    if (request?.status) {
      status.current?.focus()
    }
  }, [request?.status])
  const rows = useMemo(() => request?.rows ?? [], [request?.rows])
  const positions = useMemo(
    () => new Map(rows.map((row, index) => [cleanupChangeRowKey(row), index + 1])),
    [rows]
  )
  const deleted = rows.filter((row) => !request?.kept.has(cleanupChangeRowKey(row)))
  const deletedBytes = deleted.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
  const existing = request
    ? cleanupExistingRuleNotice(rows, request.newKeys, request.currentKeys)
    : null
  const rule = request ? workspaceCleanupConfirmedSettingTitle(request.setting) : ''
  const project = request?.projectName
  const disablingProtection = request?.kind === 'disable-ignored-files'
  const enabling = request?.kind === 'enable'
  const title = disablingProtection
    ? t(
        'components.settings.workspaceCleanup.disableIgnoredFiles.title',
        'Turn off ignored-file protection?'
      )
    : request?.kind === 'inherit'
      ? t(
          'components.settings.workspaceCleanup.change.inheritTitle',
          'Use global rules for {{project}}?',
          { project }
        )
      : project
        ? enabling
          ? t(
              'components.settings.workspaceCleanup.change.projectEnableTitle',
              'Turn on {{rule}} for {{project}}?',
              { rule, project }
            )
          : t(
              'components.settings.workspaceCleanup.change.projectTitle',
              'Change {{rule}} for {{project}}?',
              { rule, project }
            )
        : enabling
          ? t('components.settings.workspaceCleanup.enable.title', 'Turn on {{rule}}?', { rule })
          : t('components.settings.workspaceCleanup.change.title', 'Change {{rule}}?', { rule })
  const description =
    disablingProtection && !rows.length
      ? t(
          'components.settings.workspaceCleanup.disableIgnoredFiles.noMatches',
          'No additional workspaces match right now. This setting affects future cleanup in projects using these rules.'
        )
      : request?.kind === 'inherit'
        ? t(
            'components.settings.workspaceCleanup.change.inheritDescription',
            "{{count}} workspaces match the global rules now. They'll be deleted a few seconds after you switch.",
            {
              count: rows.length,
              defaultValue_one:
                "1 workspace matches the global rules now. It'll be deleted a few seconds after you switch."
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
              'components.settings.workspaceCleanup.change.fullDescription',
              "{{count}} workspaces match now. They'll be deleted a few seconds after you apply this change.",
              {
                count: rows.length,
                defaultValue_one:
                  "1 workspace matches now. It'll be deleted a few seconds after you apply this change."
              }
            )
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          onCancel()
        }
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        surface="security"
        {...(disablingProtection
          ? { 'aria-describedby': 'cleanup-protection-risk cleanup-protection-consequences' }
          : {})}
        showCloseButton={!confirming}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {disablingProtection ? (
            <p id="cleanup-protection-risk" className="text-sm text-muted-foreground">
              {t(
                'components.settings.workspaceCleanup.disableIgnoredFiles.description',
                'For projects using these cleanup rules, ignored files will no longer prevent automatic cleanup. Files such as .env and local config may be deleted and cannot be recovered.'
              )}
            </p>
          ) : null}
          <DialogDescription
            {...(disablingProtection ? { id: 'cleanup-protection-consequences' } : {})}
          >
            {description}
          </DialogDescription>
        </DialogHeader>
        {disablingProtection && rows.length ? (
          <p id="cleanup-pin-note" className="text-xs text-muted-foreground">
            {t(
              'components.settings.workspaceCleanup.pinAndKeep.description',
              'Selected workspaces will be pinned when you confirm. Pinned workspaces are excluded from automatic cleanup until you unpin them.'
            )}
          </p>
        ) : null}
        {request?.status ? (
          <div ref={status} role="status" tabIndex={-1} className="space-y-1 text-sm outline-none">
            {request.status.deleted.length ? (
              <p>
                {request.status.deleted.length === 1
                  ? t(
                      'components.settings.workspaceCleanup.change.keptDeleted',
                      '{{name}} was already deleted.',
                      { name: request.status.deleted[0] }
                    )
                  : t(
                      'components.settings.workspaceCleanup.change.keptDeletedCount',
                      '{{count}} kept workspaces were already deleted.',
                      {
                        count: request.status.deleted.length,
                        defaultValue_one: '1 kept workspace was already deleted.'
                      }
                    )}
              </p>
            ) : null}
            {request.status.added ? (
              <p>
                {t(
                  'components.settings.workspaceCleanup.change.moreMatches',
                  '{{count}} more workspaces match now. Review and confirm again.',
                  {
                    count: request.status.added,
                    defaultValue_one: '1 more workspace matches now. Review and confirm again.'
                  }
                )}
              </p>
            ) : null}
          </div>
        ) : null}
        <div
          ref={setScroller}
          role="list"
          tabIndex={0}
          aria-label={title}
          className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted px-3 scrollbar-sleek"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !rows.length) {
              return
            }
            event.preventDefault()
            const previous = rows.findIndex((row) => cleanupChangeRowKey(row) === activeKey)
            const index =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(rows.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1))
                    )
            const key = cleanupChangeRowKey(rows[index])
            setActiveKey(key)
            requestAnimationFrame(() =>
              scroller
                ?.querySelector<HTMLButtonElement>(`[data-keep-key="${CSS.escape(key)}"]`)
                ?.focus()
            )
          }}
        >
          <VirtualizedList
            rows={rows}
            getRowKey={cleanupChangeRowKey}
            scrollElement={scroller}
            activeRowKey={activeKey}
            estimateRowHeightPx={48}
            renderRow={(row) => {
              const key = cleanupChangeRowKey(row),
                keep = request?.kept.has(key),
                isNew = request?.newKeys.has(key)
              return (
                <div
                  key={key}
                  role="listitem"
                  aria-setsize={rows.length}
                  aria-posinset={positions.get(key)}
                  aria-label={`${isNew ? `${t('components.settings.workspaceCleanup.change.new', 'New')} ` : ''}${row.displayName}`}
                  className="flex min-w-0 items-center gap-2 border-b border-border py-2"
                >
                  {isNew ? (
                    <span className="shrink-0 rounded-full border border-border px-1.5 text-xs">
                      {t('components.settings.workspaceCleanup.change.new', 'New')}
                    </span>
                  ) : null}
                  <WorkspaceCleanupWorkspaceLine
                    workspace={row}
                    hideProject={Boolean(project)}
                    className="flex-1"
                  />
                  {row.evaluation.action !== 'keep' ? (
                    <span className="hidden sm:inline-flex">
                      <WorkspaceCleanupReasonChip
                        reason={row.evaluation.reason}
                        prNumber={row.prNumber}
                      />
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
                      aria-describedby={disablingProtection ? 'cleanup-pin-note' : undefined}
                      checked={Boolean(keep)}
                      disabled={confirming || settling}
                      onFocus={() => setActiveKey(key)}
                      onCheckedChange={() => onToggleKeep(row)}
                      aria-label={
                        disablingProtection
                          ? t(
                              'components.settings.workspaceCleanup.pinAndKeep.named',
                              'Pin and keep {{name}}',
                              { name: row.displayName }
                            )
                          : t(
                              'components.settings.workspaceCleanup.enable.keepNamed',
                              'Keep {{name}}',
                              { name: row.displayName }
                            )
                      }
                    />
                    {disablingProtection
                      ? t('components.settings.workspaceCleanup.pinAndKeep.label', 'Pin and keep')
                      : t('components.settings.workspaceCleanup.enable.keep', 'Keep')}
                  </label>
                </div>
              )
            }}
          />
        </div>
        <DialogFooter className="flex-col items-stretch sm:flex-row sm:items-end">
          <div
            className="mr-auto min-w-0 space-y-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <p className="tabular-nums">
              {t(
                'components.settings.workspaceCleanup.enable.summary',
                '{{count}} will be deleted',
                { count: deleted.length, defaultValue_one: '1 will be deleted' }
              )}
              {deletedBytes > 0 ? ` · ${formatBytes(deletedBytes)}` : null}
            </p>
            {request?.kept.size ? (
              <p>
                {t(
                  'components.settings.workspaceCleanup.change.keptPinned',
                  'Kept workspaces get pinned.'
                )}
              </p>
            ) : null}
            {existing === 'all' ? (
              <p>
                {t(
                  'components.settings.workspaceCleanup.change.alreadySet',
                  'Rows without New are already set to be deleted.'
                )}
              </p>
            ) : existing === 'some' ? (
              <p>
                {t(
                  'components.settings.workspaceCleanup.change.cancelCurrent',
                  "Cancel won't stop current rules from deleting some of these."
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert">
                {error}{' '}
                {onRetry ? (
                  <button type="button" className="underline" onClick={onRetry}>
                    {t('components.settings.workspaceCleanup.retry', 'Try again')}
                  </button>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={confirming}>
              {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
            </Button>
            <Button
              variant={disablingProtection ? 'destructive' : 'default'}
              onClick={() => void onConfirm()}
              disabled={confirming || settling}
            >
              {disablingProtection
                ? t(
                    'components.settings.workspaceCleanup.disableIgnoredFiles.turnOff',
                    'Turn off protection'
                  )
                : request?.kind === 'inherit'
                  ? t('components.settings.repository.workspaceCleanup.useGlobal', 'Use global')
                  : enabling
                    ? t('components.settings.workspaceCleanup.enable.turnOn', 'Turn on')
                    : t('components.settings.workspaceCleanup.change.apply', 'Apply')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
