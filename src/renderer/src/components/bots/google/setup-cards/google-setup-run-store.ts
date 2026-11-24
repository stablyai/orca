// Each bot's Google setup run as its setup cards read it. One read per bot however many cards it has
// in the chat; the host's bots-changed notice (sent on every run change) has it read again.
import { useEffect, useSyncExternalStore } from 'react'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { Bot } from '../../../../../../shared/bot-types'
import type {
  GOOGLE_SETUP_STARTED_FROM,
  GoogleSetupKeyCandidate
} from '../../../../../../shared/rpc-contract/google-setup-params'
import type {
  GoogleSetupCard,
  GoogleSetupRun
} from '../../../../../../shared/google/google-setup-run'
import type { GoogleSetupBlocker } from '../../../../../../shared/google/google-setup-blocker'

type Entry = {
  bot: BotRef
  run: GoogleSetupRun | null
  /** Where the host says the setup is stuck, and the owner's buttons; null while it moves. */
  blocker: GoogleSetupBlocker | null
  readers: number
  /** Every run id read or asked for, so a card from an unseen run reads once, not on every render. */
  known: Set<string>
  /** Raised per request; a reply older than the last one applied is dropped. */
  asked: number
  applied: number
}

/** The host's run and where it's stuck, as one reading. */
type Snapshot = { run: GoogleSetupRun | null; blocker: GoogleSetupBlocker | null }

// By botRefKey.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
// Mounted cards across all bots; the window listens for bots-changed only while there are some.
let attached = 0
let stopListening: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

const sameBlocker = (a: GoogleSetupBlocker | null, b: GoogleSetupBlocker | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

function store(key: string, ticket: number, snapshot: Snapshot): void {
  const entry = entries.get(key)
  if (!entry || ticket < entry.applied) {
    return
  }
  entry.applied = ticket
  const { run, blocker } = snapshot
  if (run) {
    entry.known.add(run.id)
  }
  const sameRun = entry.run?.id === run?.id && entry.run?.revision === run?.revision
  if (sameRun && sameBlocker(entry.blocker, blocker)) {
    return
  }
  entry.run = run
  entry.blocker = blocker
  emit()
}

/** Calls the host and applies its reply, unless a later request's reply is already in. */
type SetupCall =
  | { method: 'bots.googleSetup.read'; params: { botId: string } }
  | {
      method: 'bots.googleSetup.answer'
      params: { botId: string; card: GoogleSetupCard; values: string[] }
    }
  | { method: 'bots.googleSetup.write'; params: { botId: string; change: { action: 'cancel' } } }
  | {
      method: 'bots.googleSetup.importHostKey'
      params: { botId: string; file?: { name: string; id: string } }
    }

async function call<T extends Snapshot>(bot: BotRef, { method, params }: SetupCall): Promise<T> {
  const key = botRefKey(bot)
  const entry = entries.get(key)
  const ticket = entry ? ++entry.asked : 0
  const snapshot = await callBotRpc<T>(bot, method, params)
  store(key, ticket, snapshot)
  return snapshot
}

async function read(bot: BotRef): Promise<void> {
  await call(bot, { method: 'bots.googleSetup.read', params: { botId: bot.id } }).catch(
    () => undefined
  )
}

function rereadHost(hostId: ExecutionHostId): void {
  for (const entry of entries.values()) {
    if (entry.readers > 0 && entry.bot.hostId === hostId) {
      void read(entry.bot)
    }
  }
}

function attach(bot: BotRef): () => void {
  const key = botRefKey(bot)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      bot: { hostId: bot.hostId, id: bot.id },
      run: null,
      blocker: null,
      readers: 0,
      known: new Set(),
      asked: 0,
      applied: 0
    }
    entries.set(key, entry)
  }
  entry.readers += 1
  if (entry.readers === 1) {
    void read(entry.bot)
  }
  if (attached === 0) {
    stopListening = onBotsChanged(rereadHost, undefined, { kinds: ['settings', 'bot'] })
  }
  attached += 1
  return () => {
    const current = entries.get(key)
    if (!current) {
      return
    }
    current.readers -= 1
    attached -= 1
    if (attached === 0) {
      stopListening?.()
      stopListening = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The bot's setup run; null until read, or when it has none. A card from a run this window hasn't
 *  seen (a setup started since) reads again, once. */
export function useGoogleSetupRun(bot: BotRef | null, runId?: string): GoogleSetupRun | null {
  const hostId = bot?.hostId ?? null
  const botId = bot?.id ?? null
  const key = bot ? botRefKey(bot) : null
  useEffect(() => (hostId && botId ? attach({ hostId, id: botId }) : undefined), [hostId, botId])
  const run = useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.run : null) ?? null)
  useEffect(() => {
    const entry = key ? entries.get(key) : undefined
    if (!entry || !run || !runId || entry.known.has(runId)) {
      return
    }
    entry.known.add(runId)
    void read(entry.bot)
  }, [key, runId, run])
  return run
}

/** Where the bot's setup is stuck and what the owner can press, as the host last said. */
export function useGoogleSetupBlocker(bot: BotRef): GoogleSetupBlocker | null {
  const key = botRefKey(bot)
  return useSyncExternalStore(subscribe, () => entries.get(key)?.blocker ?? null)
}

/** Records the owner's answer and tells the bot, with no message in the chat. */
export async function answerGoogleSetup(
  bot: BotRef,
  card: GoogleSetupCard,
  values: string[]
): Promise<void> {
  await call(bot, {
    method: 'bots.googleSetup.answer',
    params: { botId: bot.id, card, values }
  })
}

/** The owner's Stop setup: the run ends; what's done in Google Cloud and any account signed in stay. */
export async function stopGoogleSetup(bot: BotRef): Promise<void> {
  await call(bot, {
    method: 'bots.googleSetup.write',
    params: { botId: bot.id, change: { action: 'cancel' } }
  })
}

export type HostKeyImport =
  | { found: true }
  | { found: false; candidates: GoogleSetupKeyCandidate[] }

/** Import file for a bot on another host: that host imports the key its Orca browser saved in the
 *  bot's home, or lists the files to pick from (`file` is the pick). Null for a local bot, or a host
 *  that predates it, so this computer picks. */
export async function importGoogleSetupKeyOnHost(
  bot: BotRef,
  file?: GoogleSetupKeyCandidate
): Promise<HostKeyImport | null> {
  if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  try {
    const reply = await call<Snapshot & HostKeyImport>(bot, {
      method: 'bots.googleSetup.importHostKey',
      params: { botId: bot.id, ...(file ? { file: { name: file.name, id: file.id } } : {}) }
    })
    return reply.found ? { found: true } : { found: false, candidates: reply.candidates ?? [] }
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return null
    }
    throw error
  }
}

/** Opens the bot's chat and starts its Google setup there, with no message in the person's name. */
export async function startGoogleSetupInChat(
  bot: Pick<Bot, 'id'> & Parameters<typeof openBotHomeTab>[0],
  from: (typeof GOOGLE_SETUP_STARTED_FROM)[number],
  options?: { newApp?: true }
): Promise<void> {
  await callBotRpc(bot, 'bots.googleSetup.start', { botId: bot.id, from, ...options })
  await openBotHomeTab(bot)
}
