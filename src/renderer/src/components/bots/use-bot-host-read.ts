import { usePairedActivityRefresh } from './use-paired-activity-refresh'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botRefKey, botTarget } from '@/lib/bot-hosts'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  AUTOMATIONS_CHANGED_EVENT,
  automationsChangedWindowDetail
} from '@/components/automations/events/automations-changed-window-event'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChangeKind, BotChangeScope } from '../../../../shared/bots/bot-change-scope'
import type { BotHostRead } from './bot-host-read-store'

export { createBotHostRead, type BotHostRead, type BotHostReadState } from './bot-host-read-store'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const NO_SUBSCRIPTION = (): (() => void) => () => {}
/** The changes the store sees first: a read of none of them (items) re-reads on its host's notices only. */
const CHAT_KINDS: readonly BotChangeKind[] = ['chats', 'status', 'threads']

/** The read's latest value for the bot, re-read whenever its chats, threads, Home chat or work change;
 *  null until the first read lands, or with no bot. */
export function useBotHostRead<T>(read: BotHostRead<T>, bot: Bot | null): T | null {
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const key = bot ? botRefKey(bot) : null
  const workspaceId = bot ? folderWorkspaceKey(bot.folderWorkspaceId) : null
  const chatSessionId = bot?.chatSessionId ?? null
  const statusPaneKey = useMemo(
    () => (chatSessionId ? chatPaneKey(chatSessionId) : null),
    [chatSessionId]
  )
  // A new chat, thread or turn of the Home chat re-reads at once, for a read that shows them.
  const followsChats = read.kinds.some((kind) => CHAT_KINDS.includes(kind))
  const chatsKey = useAppStore((s) =>
    followsChats && workspaceId
      ? (s.unifiedTabsByWorktree[workspaceId] ?? [])
          .flatMap((tab) => (tab.contentType === 'agent-session' ? [tab.entityId] : []))
          .join('|')
      : ''
  )
  const threadsKey = useAppStore((s) =>
    followsChats && bot
      ? (
          selectFolderWorkspaces(s).find((workspace) => workspace.id === bot.folderWorkspaceId)
            ?.externalConversations ?? []
        )
          .map((link) => link.sessionId ?? link.paneKey)
          .join('|')
      : ''
  )
  const chatState = useAppStore((s) =>
    followsChats && statusPaneKey ? s.agentStatusByPaneKey.get(statusPaneKey)?.state : undefined
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      botId && hostId ? read.subscribe({ hostId, id: botId }, listener) : NO_SUBSCRIPTION(),
    [read, botId, hostId]
  )
  const getSnapshot = useCallback(() => (key ? read.snapshot(key) : null), [read, key])
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!botId || !hostId) {
      return
    }
    const ref = { hostId, id: botId }
    read.request(ref)
    // Only a read that shows automations re-reads for their runs (the Items list doesn't).
    if (!read.kinds.includes('automations')) {
      return
    }
    const environmentId = runtimeTargetEnvironmentId(botTarget(ref))
    const reload = (event: Event): void => {
      if ((automationsChangedWindowDetail(event).environmentId ?? null) === environmentId) {
        read.request(ref)
      }
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, reload)
    return () => {
      window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, reload)
    }
  }, [read, botId, hostId, chatsKey, threadsKey, chatState])

  // The host says when the bot's work changes; a hidden window reads once it shows again.
  useEffect(() => {
    if (!botId || !hostId) {
      return
    }
    const ref = { hostId, id: botId }
    let missed = false
    const onChanged = (_host: unknown, scope: BotChangeScope | undefined): void => {
      if (document.visibilityState === 'visible') {
        read.request(ref, read.partsOf(scope, ref))
      } else {
        missed = true
      }
    }
    const onVisible = (): void => {
      if (missed && document.visibilityState === 'visible') {
        missed = false
        read.request(ref)
      }
    }
    // Only a change to this bot of a kind the read shows; an older host's notice names none and counts.
    const stopListening = onBotsChanged(onChanged, hostId, { botId, kinds: read.kinds })
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopListening()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [read, botId, hostId])

  const refresh = useCallback(() => {
    if (botId && hostId) {
      read.request({ hostId, id: botId })
    }
  }, [read, botId, hostId])
  usePairedActivityRefresh((bot?.handedPairedWorkspaces?.length ?? 0) > 0, refresh)

  return value
}
