import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { VirtualizedList } from '../../ui/virtualized-list'
import { WorkspaceCleanupRuleChangeRow } from './workspace-cleanup-rule-change-row'
import {
  WorkspaceCleanupChangeFeedback,
  type CleanupPinFailure
} from './workspace-cleanup-change-feedback'
import { WorkspaceCleanupKeepSelection } from './workspace-cleanup-keep-selection'
import type {
  WorkspaceCleanupPolicyState,
  WorkspaceCleanupPolicyChange
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { resolveWorkspaceCleanupPolicy } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { formatWorkspaceCleanupRuleSummary } from './workspace-cleanup-rule-summary'
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
  selection: WorkspaceCleanupKeepSelection
  reviewed?: { state: WorkspaceCleanupPolicyState; change: WorkspaceCleanupPolicyChange }
  status: { added: number; deleted: string[]; policyChanged?: boolean } | null
}

const EMPTY_SELECTION = new WorkspaceCleanupKeepSelection([])

export function WorkspaceCleanupRuleChangeDialog({
  request: liveRequest,
  onCancel,
  onConfirm,
  onToggleKeep,
  confirming = false,
  settling = false,
  disconnected = false,
  pinFailure,
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
  disconnected?: boolean
  pinFailure?: CleanupPinFailure | null
  error?: string | null
  onRetry?: () => void
  onCloseAutoFocus?: (event: Event) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [shownRequest, setShownRequest] = useState(liveRequest)
  if (liveRequest && liveRequest !== shownRequest) {
    setShownRequest(liveRequest)
  }
  // Closing keeps what was reviewed on screen through the exit animation.
  const request = liveRequest ?? shownRequest
  const status = useRef<HTMLDivElement>(null)
  const failure = useRef<HTMLParagraphElement>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [activeKey, setActiveKey] = useState<string>()
  useEffect(() => {
    if (request?.status) {
      status.current?.focus()
    }
  }, [request?.status])
  useEffect(() => {
    if (error) {
      failure.current?.focus()
    }
  }, [error])
  const rows = useMemo(() => request?.rows ?? [], [request?.rows])
  const positions = useMemo(
    () => new Map(rows.map((row, index) => [cleanupChangeRowKey(row), index + 1])),
    [rows]
  )
  const selected = useSyncExternalStore(
    (request?.selection ?? EMPTY_SELECTION).subscribe,
    (request?.selection ?? EMPTY_SELECTION).getSnapshot
  )
  const totalBytes = useMemo(() => rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0), [rows])
  const deletedCount = rows.length - selected.visibleCount
  const deletedBytes = totalBytes - selected.visibleBytes
  const newKeys = request?.newKeys
  const currentKeys = request?.currentKeys
  const existing = useMemo(
    () => (newKeys && currentKeys ? cleanupExistingRuleNotice(rows, newKeys, currentKeys) : null),
    [rows, newKeys, currentKeys]
  )
  // The note matters only while a row that isn't New will still be deleted.
  const deletesExisting =
    selected.visibleCount < rows.length &&
    rows.some((row) => {
      const key = cleanupChangeRowKey(row)
      return !newKeys?.has(key) && !request?.selection.has(key)
    })
  const reviewed = request?.reviewed
  const proposedRules = reviewed
    ? reviewed.change.scope === 'global'
      ? reviewed.change.rules
      : resolveWorkspaceCleanupPolicy(
          { workspaceCleanupPolicy: reviewed.state.rules },
          { workspaceCleanupPolicy: reviewed.change.policy ?? undefined }
        ).rules
    : undefined
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
            '{{count}} workspaces match the global rules now.',
            {
              count: rows.length,
              defaultValue_one: '1 workspace matches the global rules now.'
            }
          )
        : enabling
          ? t(
              'components.settings.workspaceCleanup.enable.description',
              '{{count}} workspaces match right now.',
              {
                count: rows.length,
                defaultValue_one: '1 workspace matches right now.'
              }
            )
          : t(
              'components.settings.workspaceCleanup.change.fullDescription',
              '{{count}} workspaces match now.',
              {
                count: rows.length,
                defaultValue_one: '1 workspace matches now.'
              }
            )
  return (
    <Dialog
      open={liveRequest !== null}
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
        {request?.status ? (
          <div
            ref={status}
            role="status"
            tabIndex={-1}
            className="space-y-1 rounded-md bg-muted p-3 text-sm outline-none"
          >
            {request.status.policyChanged && proposedRules ? (
              <p>
                {t(
                  'components.settings.workspaceCleanup.change.proposalChanged',
                  'Cleanup rules changed elsewhere. Review the updated rules: {{rules}}',
                  { rules: formatWorkspaceCleanupRuleSummary(proposedRules, t) }
                )}
              </p>
            ) : null}
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
            const previous = (positions.get(activeKey ?? '') ?? 0) - 1
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
            activeRowIndex={(positions.get(activeKey ?? '') ?? 0) - 1}
            estimateRowHeightPx={48}
            renderRow={(row) => {
              const key = cleanupChangeRowKey(row)
              return (
                <WorkspaceCleanupRuleChangeRow
                  key={key}
                  row={row}
                  keep={selected.has(key)}
                  isNew={request?.newKeys.has(key) ?? false}
                  project={Boolean(project)}
                  position={positions.get(key)}
                  total={rows.length}
                  disabled={confirming || settling}
                  pinLabel={disablingProtection}
                  onToggleKeep={onToggleKeep}
                  onFocus={setActiveKey}
                />
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
                { count: deletedCount, defaultValue_one: '1 will be deleted' }
              )}
              {deletedBytes > 0 ? ` · ${formatBytes(deletedBytes)}` : null}
            </p>
            {existing === 'all' && deletesExisting ? (
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
              <WorkspaceCleanupChangeFeedback
                elementRef={failure}
                error={error}
                pinFailure={pinFailure}
                settling={settling}
                disconnected={disconnected}
                onRetry={onRetry}
              />
            ) : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={confirming}>
              {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
            </Button>
            {/* Red whenever confirming deletes at least one workspace; nothing deleted, normal. */}
            <Button
              variant={deletedCount > 0 ? 'destructive' : 'default'}
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
