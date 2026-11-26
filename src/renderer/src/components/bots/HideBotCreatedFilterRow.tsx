import React from 'react'
import { Bot } from 'lucide-react'
import { FilterToggleRow } from '@/components/sidebar/worktree-list/controls/FilterToggleRow'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'

/** Workspace options › Filters row for a bot's workspaces; only bots on this computer have them. */
export function HideBotCreatedFilterRow(): React.JSX.Element | null {
  const t = useTranslate()
  const hide = useAppStore((s) => s.hideBotCreatedWorkspaces)
  const setHide = useAppStore((s) => s.setHideBotCreatedWorkspaces)
  const botsEnabled = useBotsEnabled()
  const hasBots = useBots(botsEnabled).length > 0
  // Kept while off so the change stays reachable to undo.
  if (!hasBots && hide) {
    return null
  }
  return (
    <FilterToggleRow
      icon={<Bot className="size-3.5" />}
      label={t('bots.workspaces.hideBotWorkspaces', 'Hide bot workspaces')}
      ariaLabel={t(
        'bots.workspaces.hideBotWorkspacesAria',
        "List a bot's workspaces, made or taken over, only under the bot, not in their project"
      )}
      checked={hide}
      onChange={setHide}
    />
  )
}
