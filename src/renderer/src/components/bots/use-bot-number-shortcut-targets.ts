import { useLayoutEffect, useMemo } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { BotSidebarEntry } from '../../../../shared/bots/bot-sidebar-entries'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { setBotNumberShortcutTargets } from '@/components/sidebar/number-shortcuts/sidebar-number-shortcut-targets'
import { openBotFromSidebar } from './BotRow'

/** Publishes the listed bot rows, in shown order, as Cmd/Ctrl+1–9 targets; none while the list is folded or searching. */
export function useBotNumberShortcutTargets(args: {
  entries: readonly BotSidebarEntry<Bot, BotGroup, FolderWorkspace>[]
  listed: boolean
  onOpenBot: () => void
}): void {
  const { entries, listed, onOpenBot } = args
  const targets = useMemo(
    () =>
      listed
        ? entries.flatMap((entry) =>
            entry.kind === 'bot'
              ? [
                  {
                    entryKey: entry.id,
                    open: () => {
                      openBotFromSidebar(entry.bot, onOpenBot)
                    }
                  }
                ]
              : []
          )
        : [],
    [entries, listed, onOpenBot]
  )
  // Why layout effect: Cmd/Ctrl+1–9 can fire right after commit, as for the workspace list's targets.
  useLayoutEffect(() => {
    setBotNumberShortcutTargets(targets)
  }, [targets])
  useLayoutEffect(() => () => setBotNumberShortcutTargets(null), [])
}
