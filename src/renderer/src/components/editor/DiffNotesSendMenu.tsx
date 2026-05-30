import React, { useMemo } from 'react'
import type { DiffComment } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'

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
  align = 'end'
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
}): React.JSX.Element {
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
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
      label: 'All unsent notes',
      notes: unsentNotes,
      prompt: unsentPrompt
    }
    if (!canSendFileScope) {
      return [allNotesScope]
    }
    return [
      {
        id: 'file',
        label: 'This file',
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
      onDelivered={(notes) => void clearDeliveredDiffComments(worktreeId, notes)}
    />
  )
}
