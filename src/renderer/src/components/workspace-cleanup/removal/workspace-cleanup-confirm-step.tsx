import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  needsWorkspaceCleanupRemovalApproval,
  type WorkspaceCleanupCandidate
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { WorkspaceCleanupDialogHeader } from '../dialog/workspace-cleanup-dialog-header'
import { WorkspaceCleanupRunRowLabel } from './run/workspace-cleanup-run-row-label'
import { formatWorkspaceCleanupRelativeTime } from '../candidate-list/workspace-cleanup-relative-time'

const COLLAPSED_ROW_COUNT = 5
// A section only collapses when it is long enough that "Show more" hides a meaningful stretch.
const COLLAPSE_THRESHOLD = 8

export function splitWorkspaceCleanupConfirmSections(
  candidates: readonly WorkspaceCleanupCandidate[]
): {
  localFiles: WorkspaceCleanupCandidate[]
  nothingLocal: WorkspaceCleanupCandidate[]
} {
  const localFiles: WorkspaceCleanupCandidate[] = []
  const nothingLocal: WorkspaceCleanupCandidate[] = []
  for (const candidate of candidates) {
    ;(needsWorkspaceCleanupRemovalApproval(candidate) ? localFiles : nothingLocal).push(candidate)
  }
  return { localFiles, nothingLocal }
}

export function WorkspaceCleanupConfirmStep({
  candidates,
  now,
  onBack,
  onClose,
  onConfirm
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  /** The dialog's "as of" clock; keeps "d ago" consistent with the list step. */
  now: number
  onBack: () => void
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const backButton = useRef<HTMLButtonElement>(null)
  const sections = useMemo(() => splitWorkspaceCleanupConfirmSections(candidates), [candidates])
  useLayoutEffect(() => backButton.current?.focus(), [])
  return (
    <>
      <WorkspaceCleanupDialogHeader
        title={t('components.workspace.cleanup.confirm.title', 'Delete {{count}} workspaces?', {
          count: candidates.length,
          defaultValue_one: 'Delete {{count}} workspace?'
        })}
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 flex-1">
        {sections.localFiles.length > 0 ? (
          <ConfirmSection
            title={t(
              'components.workspace.cleanup.confirm.localFilesSection',
              'Local files will be lost'
            )}
            warning
            rows={sections.localFiles}
            now={now}
          />
        ) : null}
        {sections.nothingLocal.length > 0 ? (
          <ConfirmSection
            title={t('components.workspace.cleanup.group.nothingLocal', 'Nothing local')}
            rows={sections.nothingLocal}
            now={now}
          />
        ) : null}
      </ScrollArea>
      <DialogFooter variant="bar" className="flex-row flex-wrap justify-between sm:justify-between">
        <Button ref={backButton} variant="outline" onClick={onBack}>
          {t('components.workspace.cleanup.confirm.back', 'Back')}
        </Button>
        <Button variant="destructive" disabled={candidates.length === 0} onClick={onConfirm}>
          {t('components.workspace.cleanup.confirm.deletePermanently', 'Delete permanently')}
        </Button>
      </DialogFooter>
    </>
  )
}

function ConfirmSection({
  title,
  warning = false,
  rows,
  now
}: {
  title: string
  warning?: boolean
  rows: readonly WorkspaceCleanupCandidate[]
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const collapsible = rows.length > COLLAPSE_THRESHOLD
  const visible = collapsible && !expanded ? rows.slice(0, COLLAPSED_ROW_COUNT) : rows
  const hiddenCount = rows.length - visible.length
  return (
    <section aria-label={title}>
      <h3
        className={cn(
          'sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-muted px-4 py-2 text-xs font-medium',
          warning ? 'text-status-warning-text' : 'text-foreground'
        )}
      >
        {title}
        <span className="tabular-nums">{rows.length}</span>
      </h3>
      <div role="list">
        {visible.map((candidate) => (
          <div
            role="listitem"
            key={getWorkspaceCleanupCandidateIdentity(candidate)}
            className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5"
          >
            <WorkspaceCleanupRunRowLabel
              candidate={candidate}
              group={warning ? 'local-files' : 'nothing-local'}
            />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatWorkspaceCleanupRelativeTime(candidate.lastActivityAt, now, t)}
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <div className="border-b border-border/60 px-4 py-2">
          <Button variant="link" size="inline" onClick={() => setExpanded(true)}>
            {t('components.workspace.cleanup.confirm.showMore', 'Show {{count}} more', {
              count: hiddenCount
            })}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
