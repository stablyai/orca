import React, { useCallback, useMemo } from 'react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useAppStore } from '@/store'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

// Expire unconsumed keyboard requests so navigating away cannot reopen the menu on a later mount.
const OPEN_REQUEST_TTL_MS = 5000

export function DiffNotesSendMenu({
  worktreeId,
  groupId,
  comments,
  filePath,
  showFileScope = false,
  triggerClassName,
  triggerLabel,
  triggerCount,
  actionLabel,
  iconClassName = 'size-3.5',
  align = 'end',
  respondToOpenRequest = false
}: {
  worktreeId: string
  groupId: string
  comments: readonly DiffComment[]
  filePath?: string
  showFileScope?: boolean
  triggerClassName?: string
  triggerLabel?: string
  triggerCount?: number
  actionLabel?: string
  iconClassName?: string
  align?: 'start' | 'center' | 'end'
  // Enable on exactly one instance per worktree to avoid opening multiple menus for one shortcut.
  respondToOpenRequest?: boolean
}): React.JSX.Element {
  const languageRevision = useUiLanguageRevision()
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const openRequest = useAppStore((s) => s.diffNotesSendMenuOpenRequest)
  const consumeOpenRequest = useAppStore((s) => s.consumeDiffNotesSendMenuOpenRequest)
  // Enforce TTL when opening commits in NotesSendMenu; render-time clocks are stale or require polling.
  const hasPendingOpenRequest = respondToOpenRequest && openRequest?.worktreeId === worktreeId
  const openRequestNonce = hasPendingOpenRequest ? (openRequest?.nonce ?? null) : null
  const openRequestExpiresAt = hasPendingOpenRequest
    ? (openRequest?.issuedAt ?? 0) + OPEN_REQUEST_TTL_MS
    : null
  const handleOpenRequestHandled = useCallback(
    () => consumeOpenRequest(worktreeId),
    [consumeOpenRequest, worktreeId]
  )
  const unsentNotes = useMemo(() => comments.filter((comment) => !comment.sentAt), [comments])
  const fileNotes = useMemo(
    () => (filePath ? comments.filter((comment) => comment.filePath === filePath) : []),
    [comments, filePath]
  )
  const unsentFileNotes = useMemo(() => fileNotes.filter((comment) => !comment.sentAt), [fileNotes])
  const canSendFileScope = showFileScope && Boolean(filePath)
  const scopes = useMemo<NotesSendMenuScope<DiffComment>[]>(() => {
    const allNotesScope = {
      id: 'all',
      label: translate('auto.components.editor.DiffNotesSendMenu.8b87612461', 'All unsent notes'),
      notes: unsentNotes,
      formatPrompt: formatDiffComments
    }
    if (!canSendFileScope) {
      return [allNotesScope]
    }
    return [
      {
        id: 'file',
        label: translate('auto.components.editor.DiffNotesSendMenu.f1aa04b5cf', 'This file'),
        notes: unsentFileNotes,
        formatPrompt: formatDiffComments
      },
      allNotesScope
    ]
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [canSendFileScope, unsentFileNotes, unsentNotes, languageRevision])

  return (
    <NotesSendMenu
      worktreeId={worktreeId}
      groupId={groupId}
      modeIdParts={['diff-notes', worktreeId, groupId, filePath ?? 'all']}
      scopes={scopes}
      // File menus must not broaden delivery before the user enters All unsent notes.
      defaultScopeId={canSendFileScope ? 'file' : 'all'}
      triggerClassName={triggerClassName}
      triggerLabel={triggerLabel}
      triggerCount={triggerCount}
      actionLabel={actionLabel}
      iconClassName={iconClassName}
      align={align}
      openRequestNonce={openRequestNonce}
      openRequestExpiresAt={openRequestExpiresAt}
      onOpenRequestHandled={handleOpenRequestHandled}
      onDelivered={(notes) => void clearDeliveredDiffComments(worktreeId, notes)}
    />
  )
}
