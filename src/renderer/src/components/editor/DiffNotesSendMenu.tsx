import React, { useCallback, useMemo } from 'react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useAppStore } from '@/store'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'
import { translate } from '@/i18n/i18n'

// Why: a keyboard open request the menu never got to consume (e.g. the user
// navigated away before it mounted) must not reopen the menu on a later remount.
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
  // When set, this menu opens in response to the store's keyboard-shortcut open
  // request. Enable on exactly one instance per worktree to avoid double-open.
  respondToOpenRequest?: boolean
}): React.JSX.Element {
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const openRequest = useAppStore((s) => s.diffNotesSendMenuOpenRequest)
  const consumeOpenRequest = useAppStore((s) => s.consumeDiffNotesSendMenuOpenRequest)
  // Why: the TTL is a deadline, not a label, so it is enforced on the commit
  // that opens the menu (see NotesSendMenu) where the clock is exact — a render
  // clock either burns a tick per second or reads stale at the moment it matters.
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
  const unsentPrompt = useMemo(() => formatDiffComments(unsentNotes), [unsentNotes])
  const fileNotes = useMemo(
    () => (filePath ? comments.filter((comment) => comment.filePath === filePath) : []),
    [comments, filePath]
  )
  const unsentFileNotes = useMemo(() => fileNotes.filter((comment) => !comment.sentAt), [fileNotes])
  const unsentFilePrompt = useMemo(() => formatDiffComments(unsentFileNotes), [unsentFileNotes])
  const canSendFileScope = showFileScope && Boolean(filePath)
  const scopes = useMemo<NotesSendMenuScope<DiffComment>[]>(() => {
    const allNotesScope = {
      id: 'all',
      label: translate('auto.components.editor.DiffNotesSendMenu.8b87612461', 'All unsent notes'),
      notes: unsentNotes,
      prompt: unsentPrompt
    }
    if (!canSendFileScope) {
      return [allNotesScope]
    }
    return [
      {
        id: 'file',
        label: translate('auto.components.editor.DiffNotesSendMenu.f1aa04b5cf', 'This file'),
        notes: unsentFileNotes,
        prompt: unsentFilePrompt
      },
      allNotesScope
    ]
  }, [canSendFileScope, unsentFileNotes, unsentFilePrompt, unsentNotes, unsentPrompt])

  return (
    <NotesSendMenu
      worktreeId={worktreeId}
      groupId={groupId}
      modeIdParts={['diff-notes', worktreeId, groupId, filePath ?? 'all']}
      scopes={scopes}
      // Why: file-scoped menus should not broaden delivery before the user
      // intentionally hovers the "All unsent notes" submenu.
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
