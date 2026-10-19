import React from 'react'
import { useAppStore } from '@/store'
import WorktreeMetaDialogDraft from './WorktreeMetaDialogDraft'
import { getWorktreeMetaDialogOwner } from './worktree-meta-dialog-owner'

export default function WorktreeMetaDialog(): React.JSX.Element {
  const owner = useAppStore(getWorktreeMetaDialogOwner)
  return <WorktreeMetaDialogDraft key={owner ?? 'closed'} />
}
