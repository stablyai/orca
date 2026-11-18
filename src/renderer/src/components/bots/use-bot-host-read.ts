import { usePairedActivityRefresh } from './use-paired-activity-refresh'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botRefKey, botTarget, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  AUTOMATIONS_CHANGED_EVENT,
  automationsChangedWindowDetail
} from '@/components/automations/events/automations-changed-window-event'
import type { Bot } from '../../../../shared/bot-types'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { reuseEqualJson } from '../../../../shared/reuse-equal-json'
import type { BotChangeKind } from '../../../../shared/bots/bot-change-scope'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'

type BotReadEntry<T> = {
  bot: BotRef
  value: T | null
  /** Why the last read brought nothing: the host lacks the method, or the read failed. */
  failure: 'unsupported' | 'failed' | null
  listeners: Set<() => void>
  /** Only the latest read lands, so an older one finishing late cannot overwrite it. */
  latest: number
  /** A read is queued (next microtask, or after the minimum gap). */
  scheduled: boolean
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  /** Asked again while a read ran: one more read follows it. */
  again: boolean
  startedAt: number
}

/** One host read about a bot (its Activity, its chats tree), shared by every surface showing that bot. */
export type BotHostRead<T> = {
  /** The kinds of change to the bot that can change this read. */
  kinds: readonly BotChangeKind[]
  request: (bot: BotRef) => void
  subscribe: (bot: BotRef, listener: () => void) => () => void
  snapshot: (key: string) => T | null
  /** Ready once a value landed; until then, loading or why none came. */
  state: (key: string) => BotHostReadState
  /** A value landed, but the latest read of it failed: what's shown is the last good one. */
  refreshFailed: (key: string) => boolean
}

export type BotHostReadState = 'loading' | 'ready' | 'failed' | 'unsupported'

export function createBotHostRead<T>(
  method: string,
  pick: (result: never) => T,
  failure: string,
  kinds: readonly BotChangeKind[],
  /** The least time between two reads' starts; asks in between share the one after it. */
  minIntervalMs = 0,
  /** Keep each bot's last value after its last surface closes, shown at once when one opens again while it re-reads. */
  keepLast = false
): BotHostRead<T> {
  const entries = new Map<string, BotReadEntry<T>>()
  // One value per bot, replaced by each read that lands.
  const lastValues = new Map<string, T>()

  const entryFor = (bot: BotRef): BotReadEntry<T> => {
    const key = botRefKey(bot)
    let entry = entries.get(key)
    if (!entry) {
      const ref = { hostId: bot.hostId, id: bot.id }
      entry = {
        bot: ref,
        value: lastValues.get(key) ?? null,
        failure: null,
        listeners: new Set(),
        latest: 0,
        scheduled: false,
        timer: null,
        inFlight: false,
        again: false,
        startedAt: 0
      }
      entries.set(key, entry)
    }
    return entry
  }

  const read = async (key: string, entry: BotReadEntry<T>): Promise<void> => {
    const current = ++entry.latest
    entry.inFlight = true
    entry.startedAt = Date.now()
    try {
      const result = await callBotRpc<never>(entry.bot, method, { botId: entry.bot.id })
      if (current === entry.latest && entries.get(key) === entry) {
        // What the answer repeats keeps its identity; an unchanged answer tells no one.
        const value = reuseEqualJson(entry.value, pick(result))
        if (value !== entry.value || entry.failure) {
          entry.value = value
          entry.failure = null
          if (keepLast && value) {
            lastValues.set(key, value)
          }
          entry.listeners.forEach((listener) => listener())
        }
      }
    } catch (error) {
      // An older host lacks the method on every change notice; its surface falls back quietly.
      const unsupported = hasRuntimeRpcErrorCode(error, 'method_not_found')
      if (!unsupported) {
        console.error(failure, error)
      }
      const next = unsupported ? 'unsupported' : 'failed'
      if (current === entry.latest && entries.get(key) === entry && entry.failure !== next) {
        entry.failure = next
        entry.listeners.forEach((listener) => listener())
      }
    } finally {
      entry.inFlight = false
      if (entry.again && entries.get(key) === entry) {
        entry.again = false
        request(entry.bot)
      }
    }
  }

  // Asks from one commit's consumers, and those while a read runs, share one read.
  const request = (bot: BotRef): void => {
    const key = botRefKey(bot)
    const entry = entryFor(bot)
    if (entry.inFlight) {
      entry.again = true
      return
    }
    if (entry.scheduled) {
      return
    }
    entry.scheduled = true
    const start = (): void => {
      entry.scheduled = false
      entry.timer = null
      // The last surface may have closed since the ask.
      if (entries.get(key) === entry) {
        void read(key, entry)
      }
    }
    const wait = entry.startedAt + minIntervalMs - Date.now()
    if (wait > 0) {
      entry.timer = setTimeout(start, wait)
    } else {
      queueMicrotask(start)
    }
  }

  return {
    kinds,
    request,
    subscribe: (bot, listener) => {
      const key = botRefKey(bot)
      const entry = entryFor(bot)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && entries.get(key) === entry) {
          // Nothing lands after the last surface closes.
          entry.latest += 1
          if (entry.timer) {
            clearTimeout(entry.timer)
          }
          entries.delete(key)
        }
      }
    },
    // A surface's first render reads before it subscribes, so the kept value answers until then.
    snapshot: (key) => (entries.has(key) ? entries.get(key)?.value : lastValues.get(key)) ?? null,
    state: (key) => {
      const entry = entries.get(key)
      if (!entry) {
        return lastValues.has(key) ? 'ready' : 'loading'
      }
      return entry.value ? 'ready' : (entry.failure ?? 'loading')
    },
    refreshFailed: (key) => {
      const entry = entries.get(key)
      return Boolean(entry?.value) && entry?.failure === 'failed'
    }
  }
}

const NO_SUBSCRIPTION = (): (() => void) => () => {}
/** The changes the store sees first: a read of none of them (items) re-reads on its host's notices only. */
const CHAT_KINDS: readonly BotChangeKind[] = ['chats', 'status', 'threads']

/** Whether the read has landed for the bot, and a retry; reads only while `useBotHostRead` keeps it open. */
export function useBotHostReadState(
  read: BotHostRead<unknown>,
  bot: Bot | null
): { state: BotHostReadState; refreshFailed: boolean; retry: () => void } {
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const key = bot ? botRefKey(bot) : null
  const subscribe = useCallback(
    (listener: () => void) =>
      botId && hostId ? read.subscribe({ hostId, id: botId }, listener) : NO_SUBSCRIPTION(),
    [read, botId, hostId]
  )
  const getState = useCallback(
    (): BotHostReadState => (key ? read.state(key) : 'loading'),
    [read, key]
  )
  const state = useSyncExternalStore(subscribe, getState, getState)
  const getRefreshFailed = useCallback(
    (): boolean => (key ? read.refreshFailed(key) : false),
    [read, key]
  )
  const refreshFailed = useSyncExternalStore(subscribe, getRefreshFailed, getRefreshFailed)
  const retry = useCallback(() => {
    if (botId && hostId) {
      read.request({ hostId, id: botId })
    }
  }, [read, botId, hostId])
  return { state, refreshFailed, retry }
}

/** The read's latest value for the bot, re-read whenever its chats, threads, Home chat or work change;
 *  null until the first read lands, or with no bot. */
export function useBotHostRead<T>(read: BotHostRead<T>, bot: Bot | null): T | null {
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const key = bot ? botRefKey(bot) : null
  const workspaceId = bot ? folderWorkspaceKey(bot.folderWorkspaceId) : null
  const chatSessionId = bot?.chatSessionId ?? null
  const chatPaneKey = useMemo(
    () => (chatSessionId ? structuredAgentSessionStatusPaneKey(chatSessionId) : null),
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
    followsChats && chatPaneKey ? s.agentStatusByPaneKey.get(chatPaneKey)?.state : undefined
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
    const onChanged = (): void => {
      if (document.visibilityState === 'visible') {
        read.request(ref)
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
