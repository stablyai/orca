import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectActiveWorkspaceNote, type WorkspaceNoteTarget } from './workspace-notes-state'
import {
  enqueueWorkspaceNoteSave,
  getWorkspaceNoteSaveQueue,
  subscribeToWorkspaceNoteSaveQueue,
  type WorkspaceNoteSaveAttempt
} from './workspace-note-save-queue'

export { resetWorkspaceNoteSaveStateForTests } from './workspace-note-save-queue'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type NoteViewMode = 'edit' | 'preview'

const SAVE_DEBOUNCE_MS = 250
function isCurrentTarget(
  target: WorkspaceNoteTarget | null,
  scopeKey: string,
  executionHostId: ExecutionHostId
): boolean {
  return target?.scopeKey === scopeKey && target.executionHostId === executionHostId
}

function enqueueWorkspaceNoteSaveForTarget(
  scopeKey: string,
  executionHostId: ExecutionHostId,
  comment: string,
  requestId: number
): Promise<void> {
  const queueKey = `${executionHostId}\0${scopeKey}`
  const saveAttempt = { queueKey, comment, requestId }
  return enqueueWorkspaceNoteSave(
    queueKey,
    saveAttempt,
    (generation) =>
      useAppStore.getState().updateWorktreeMeta(
        scopeKey,
        { comment },
        {
          executionHostId,
          shouldApply: (target) =>
            getWorkspaceNoteSaveQueue(queueKey)?.generation === generation && target !== undefined
        }
      ),
    () =>
      isCurrentTarget(selectActiveWorkspaceNote(useAppStore.getState()), scopeKey, executionHostId)
  )
}

export default function WorkspaceNotesPanel(): ReactElement {
  const target = useAppStore(useShallow(selectActiveWorkspaceNote))
  const targetIdentity = target ? `${target.executionHostId}\0${target.scopeKey}` : null
  const initialSaveQueue = targetIdentity ? getWorkspaceNoteSaveQueue(targetIdentity) : undefined
  const initialSaveAttempt = initialSaveQueue?.pendingSave ?? initialSaveQueue?.failedSave
  const initialDraft = initialSaveAttempt?.comment ?? target?.comment ?? ''
  const timerRef = useRef<number | null>(null)
  const previousTargetIdentityRef = useRef(targetIdentity)
  const mountedRef = useRef(true)
  const saveRequestRef = useRef(0)
  const targetRef = useRef<WorkspaceNoteTarget | null>(target)
  targetRef.current = target
  const draftRef = useRef(initialDraft)
  const synchronizedCommentRef = useRef(target?.comment ?? '')
  const pendingSaveRef = useRef<WorkspaceNoteSaveAttempt | null>(
    initialSaveQueue?.pendingSave ?? null
  )
  const failedSaveRef = useRef<WorkspaceNoteSaveAttempt | null>(
    initialSaveQueue?.failedSave ?? null
  )
  const [draft, setDraft] = useState(() => initialDraft)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [viewMode, setViewMode] = useState<NoteViewMode>('edit')

  useEffect(() => {
    const nextComment = target?.comment ?? ''
    const queueState = targetIdentity ? getWorkspaceNoteSaveQueue(targetIdentity) : undefined
    const queuedAttempt = queueState?.pendingSave ?? queueState?.failedSave
    const nextDraft = queuedAttempt?.comment ?? nextComment
    pendingSaveRef.current = queueState?.pendingSave ?? null
    failedSaveRef.current = queueState?.failedSave ?? null
    if (failedSaveRef.current) {
      setStatus('error')
    } else if (pendingSaveRef.current) {
      setStatus('saving')
    }
    if (previousTargetIdentityRef.current === targetIdentity) {
      const previousComment = synchronizedCommentRef.current
      if (previousComment === nextComment) {
        return
      }
      synchronizedCommentRef.current = nextComment
      const pendingSave = pendingSaveRef.current
      const failedSave = failedSaveRef.current
      const preservesFailedDraft =
        (pendingSave?.queueKey === targetIdentity && pendingSave.comment === previousComment) ||
        (failedSave?.queueKey === targetIdentity && failedSave.comment === draftRef.current)
      if (draftRef.current === previousComment && !preservesFailedDraft) {
        draftRef.current = nextComment
        setDraft(nextComment)
      }
      return
    }

    previousTargetIdentityRef.current = targetIdentity
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    saveRequestRef.current += 1
    draftRef.current = nextDraft
    synchronizedCommentRef.current = nextComment
    setDraft(nextDraft)
    setStatus(failedSaveRef.current ? 'error' : pendingSaveRef.current ? 'saving' : 'idle')
    setViewMode('edit')

    if (target && queueState?.pendingSave && !queueState.inFlight) {
      void enqueueWorkspaceNoteSaveForTarget(
        target.scopeKey,
        target.executionHostId,
        queueState.pendingSave.comment,
        ++saveRequestRef.current
      )
    }
  }, [target?.comment, targetIdentity])

  useEffect(() => {
    if (!targetIdentity) {
      return
    }
    return subscribeToWorkspaceNoteSaveQueue(targetIdentity, (notification) => {
      const currentTarget = selectActiveWorkspaceNote(useAppStore.getState())
      const currentTargetIdentity = currentTarget
        ? `${currentTarget.executionHostId}\0${currentTarget.scopeKey}`
        : null
      if (!mountedRef.current || currentTargetIdentity !== targetIdentity) {
        return
      }
      const previousPendingSave = pendingSaveRef.current
      const previousFailedSave = failedSaveRef.current
      pendingSaveRef.current = notification.pendingSave
      failedSaveRef.current = notification.failedSave
      const matchesCurrentAttempt =
        draftRef.current === notification.attempt.comment &&
        (notification.attempt === previousPendingSave ||
          notification.attempt === previousFailedSave ||
          (notification.status === 'saving' && notification.attempt === notification.pendingSave))
      if (!matchesCurrentAttempt) {
        return
      }
      setStatus(notification.status)
    })
  }, [targetIdentity])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        const pendingTarget = targetRef.current
        if (pendingTarget) {
          void enqueueWorkspaceNoteSaveForTarget(
            pendingTarget.scopeKey,
            pendingTarget.executionHostId,
            draftRef.current,
            ++saveRequestRef.current
          )
        }
      }
    }
  }, [])

  const saveComment = (
    scopeKey: string,
    executionHostId: ExecutionHostId,
    comment: string
  ): void => {
    void enqueueWorkspaceNoteSaveForTarget(
      scopeKey,
      executionHostId,
      comment,
      ++saveRequestRef.current
    )
  }

  const scheduleSave = (
    scopeKey: string,
    executionHostId: ExecutionHostId,
    nextDraft: string
  ): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }
    const pendingScope = scopeKey
    const pendingHostId = executionHostId
    const pendingDraft = nextDraft
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const currentTarget = selectActiveWorkspaceNote(useAppStore.getState())
      if (!isCurrentTarget(currentTarget, pendingScope, pendingHostId)) {
        return
      }
      void saveComment(pendingScope, pendingHostId, pendingDraft)
    }, SAVE_DEBOUNCE_MS)
  }

  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    if (!target) {
      return
    }
    const nextDraft = event.currentTarget.value
    draftRef.current = nextDraft
    saveRequestRef.current += 1
    if (
      failedSaveRef.current?.queueKey === targetIdentity &&
      failedSaveRef.current.comment !== nextDraft
    ) {
      const queueState = targetIdentity ? getWorkspaceNoteSaveQueue(targetIdentity) : undefined
      if (queueState) {
        queueState.failedSave = null
      }
      failedSaveRef.current = null
    }
    setDraft(nextDraft)
    setStatus('idle')
    scheduleSave(target.scopeKey, target.executionHostId, nextDraft)
  }

  const retrySave = (): void => {
    const currentTarget = selectActiveWorkspaceNote(useAppStore.getState())
    if (target && isCurrentTarget(currentTarget, target.scopeKey, target.executionHostId)) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      saveComment(target.scopeKey, target.executionHostId, draftRef.current)
    }
  }

  if (!target) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.right.sidebar.WorkspaceNotesPanel.noWorkspaceSelected',
            'No workspace selected'
          )}
        </div>
        <div className="max-w-[18rem] text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.WorkspaceNotesPanel.selectWorkspaceDescription',
            'Select a workspace to view and edit its note.'
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b border-border px-4 py-3">
        <div className="truncate text-sm font-medium text-foreground">{target.displayName}</div>
        {target.branch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {target.branch}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {target.branch}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </header>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          <div
            role="tablist"
            aria-label={translate(
              'auto.components.right.sidebar.WorkspaceNotesPanel.noteView',
              'Note view'
            )}
            className="flex gap-1 border-b border-border"
          >
            <Button
              type="button"
              variant={viewMode === 'edit' ? 'secondary' : 'ghost'}
              size="sm"
              role="tab"
              aria-selected={viewMode === 'edit'}
              onClick={() => setViewMode('edit')}
            >
              {translate('auto.components.right.sidebar.WorkspaceNotesPanel.edit', 'Edit')}
            </Button>
            <Button
              type="button"
              variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              role="tab"
              aria-selected={viewMode === 'preview'}
              onClick={() => setViewMode('preview')}
            >
              {translate('auto.components.right.sidebar.WorkspaceNotesPanel.previewTab', 'Preview')}
            </Button>
          </div>

          {viewMode === 'edit' ? (
            <>
              <label htmlFor="workspace-note" className="text-xs font-medium text-foreground">
                {translate(
                  'auto.components.right.sidebar.WorkspaceNotesPanel.workspaceNote',
                  'Workspace note'
                )}
              </label>
              <textarea
                id="workspace-note"
                aria-label={translate(
                  'auto.components.right.sidebar.WorkspaceNotesPanel.workspaceNote',
                  'Workspace note'
                )}
                rows={8}
                value={draft}
                onChange={handleDraftChange}
                className="min-h-32 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-5 shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder={translate(
                  'auto.components.right.sidebar.WorkspaceNotesPanel.notePlaceholder',
                  'Add a note for this workspace'
                )}
              />
            </>
          ) : (
            <div className="min-w-0">
              <CommentMarkdown variant="document" content={draft} className="text-sm" />
            </div>
          )}

          <div className="flex min-h-8 items-center justify-between gap-3">
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {status === 'saving'
                ? translate('auto.components.right.sidebar.WorkspaceNotesPanel.saving', 'Saving')
                : status === 'saved'
                  ? translate('auto.components.right.sidebar.WorkspaceNotesPanel.saved', 'Saved')
                  : status === 'error'
                    ? translate(
                        'auto.components.right.sidebar.WorkspaceNotesPanel.saveError',
                        'Could not save workspace note.'
                      )
                    : null}
            </span>
            {status === 'error' ? (
              <Button type="button" variant="outline" size="sm" onClick={retrySave}>
                {translate('auto.components.right.sidebar.WorkspaceNotesPanel.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
