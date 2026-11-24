import React, { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useHostBots } from '@/lib/bot-catalog'
import { getWorktreeVisitTimestamp } from '@/lib/workspace/activation/worktree-visit-recency'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { NewBotDialog } from '../NewBotDialog'
import { startGoogleSetupInChat } from './setup-cards/google-setup-run-store'

/** The host's agent whose chat the person was in last; the host's setup starts there. */
function useLastVisitedBot(hostId: ExecutionHostId): Bot | null {
  // That host's Google setup, so only its own agents.
  const bots = useHostBots(hostId)
  const selectLast = useMemo(() => createLastVisitedBotSelector(bots), [bots])
  const lastId = useAppStore(selectLast)
  return bots.find((bot) => bot.id === lastId) ?? null
}

/** The bots' last-visited id, worked out again only when the visit times change. */
function createLastVisitedBotSelector(bots: readonly Bot[]): (state: AppState) => string | null {
  let last: { visits: AppState['lastVisitedAtByWorktreeId']; id: string | null } | null = null
  return (state) => {
    const visits = state.lastVisitedAtByWorktreeId
    if (!last || last.visits !== visits) {
      let id: string | null = null
      let lastAt = -1
      for (const bot of bots) {
        const at =
          getWorktreeVisitTimestamp(visits, {
            id: folderWorkspaceKey(bot.folderWorkspaceId),
            hostId: bot.hostId
          }) ?? 0
        if (at > lastAt) {
          id = bot.id
          lastAt = at
        }
      }
      last = { visits, id }
    }
    return last.id
  }
}

/** Settings' Google setup: it runs in the chat of the host's last-visited agent, or a new one's. */
export function useGoogleSetupStart(hostId: ExecutionHostId): {
  bot: Bot | null
  start: (options?: { newApp?: true }) => void
  dialog: React.ReactNode
} {
  const bot = useLastVisitedBot(hostId)
  const [creating, setCreating] = useState<{ newApp?: true } | null>(null)
  const startIn = (target: Bot, options?: { newApp?: true }): void => {
    void startGoogleSetupInChat(target, 'settings', options).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    )
  }
  return {
    bot,
    start: (options) => (bot ? startIn(bot, options) : setCreating(options ?? {})),
    dialog: creating ? (
      <NewBotDialog
        open
        onOpenChange={(open) => !open && setCreating(null)}
        hosts={[hostId]}
        onCreated={(created) => startIn(created, creating)}
      />
    ) : null
  }
}
