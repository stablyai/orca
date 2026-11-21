import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import React from 'react'
import { FolderInput, Unlink } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { botOfFolders, selectFolderAncestors } from '@/components/bots/use-worktree-bot'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'

const NO_FOLDERS: readonly FolderWorkspace[] = []

/** Unlinking a bot's workspace moves it out from under the bot and back to its project. */
export function WorktreeRemoveParentMenuItem({
  worktree,
  onSelect,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'hostId'>
  onSelect: () => void
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  // With bots off, the home is an ordinary folder and the workspace already shows in its project.
  const botsEnabled = useBotsEnabled()
  const folders = useAppStoreWithHostStatuses((s, statuses) =>
    botsEnabled ? selectFolderAncestors(s, statuses, worktree) : NO_FOLDERS
  )
  const bot = botOfFolders(folders, useBots(folders.length > 0))
  if (bot) {
    return (
      <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
        <FolderInput className="size-3.5" />
        {t('bots.workspaces.moveToProject', 'Move to Project')}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <Unlink className="size-3.5" />
      {t('auto.components.sidebar.WorktreeContextMenu.579b1a8e61', 'Remove from Parent')}
    </DropdownMenuItem>
  )
}
