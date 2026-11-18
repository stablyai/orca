// The workspace menu's Hand to bot…, in a group of its own after Move to Status.
import React from 'react'
import { Bot as BotIcon } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBotsEnabled } from '@/lib/bot-catalog'
import { projectGroupIdFromRepoId } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../shared/worktree/types'
import { openHandToBot } from './hand-to-bot-open'

/** Only a git worktree can move under a bot's home; a folder workspace can't be handed over yet. */
export function WorktreeHandToBotMenuItem({
  worktree,
  disabled
}: {
  worktree: Worktree
  disabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const botsEnabled = useBotsEnabled()
  if (!botsEnabled || projectGroupIdFromRepoId(worktree.repoId) !== null) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openHandToBot(worktree)} disabled={disabled}>
        <BotIcon className="size-3.5" />
        {t('bots.handToBot.menu', 'Hand to bot…')}
      </DropdownMenuItem>
    </>
  )
}
