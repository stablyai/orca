// What a bot's tools are and what is wrong with them, read on the host that runs it: the tools
// themselves cheaply, and a check that starts the servers only for readers that show it.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useBots } from '@/lib/bot-catalog'
import { botRefKey, callBotRpc, isSameBot, type BotRef } from '@/lib/bot-hosts'
import { COMPOSIO_SESSION_MCP_URL } from '../../../../shared/composio/composio-apps'
import type { BotOwnTool, BotToolProblem, BotTools } from '../../../../shared/bot-tools'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { notifyToolReaders, subscribe, toolsRevision } from './bot-tools-revision'

type Problems = Record<string, BotToolProblem>

/** all: every server, as Tools shows them; remote: the URL servers only, so no command starts. */
type CheckScope = 'all' | 'remote'
const CHECK_SCOPES: readonly CheckScope[] = ['all', 'remote']

/** One check of the bot's servers, kept while some reader shows it; the last to go stops it. */
type Check = { problems: Promise<Problems>; settled: Problems | null; users: number; done: boolean }

type BotToolReads = {
  bot: BotRef
  revision: number
  /** The agent the host checked with: sign-ins live in each agent's own CLI. */
  agent: string | null
  tools: Promise<BotTools>
  checks: Partial<Record<CheckScope, Check>>
}
// Shared by every row and card of a bot until the next change: a check starts its servers. Keyed by botRefKey.
const reads = new Map<string, BotToolReads>()

// Readers of a bot's tools, told when another window or the host changed them (a sign-in's state).
const listReaders = new Map<string, Set<(tools: BotTools) => void>>()
let listeningForHost = false

/**
 * The host says its bots changed (in any window, or on its own: a sign-in ended, couldn't start):
 * every bot's tools are read again, and the checks under way keep running.
 */
function rereadToolLists(hostId: ExecutionHostId): void {
  for (const [key, read] of reads) {
    if (read.bot.hostId !== hostId) {
      continue
    }
    const tools = callBotRpc<BotTools>(read.bot, 'bots.tools.list', { botId: read.bot.id })
    read.tools = tools
    void tools.then(
      (next) => {
        for (const reader of listReaders.get(key) ?? []) {
          reader(next)
        }
      },
      () => {}
    )
  }
}

function listenForHostChanges(): void {
  if (!listeningForHost && typeof window !== 'undefined') {
    listeningForHost = true
    onBotsChanged(rereadToolLists, undefined, { kinds: ['settings', 'bot'] })
  }
}

function onToolList(bot: BotRef, reader: (tools: BotTools) => void): () => void {
  const key = botRefKey(bot)
  const readers = listReaders.get(key) ?? new Set()
  listReaders.set(key, readers)
  readers.add(reader)
  return () => {
    readers.delete(reader)
    if (readers.size === 0) {
      listReaders.delete(key)
    }
  }
}

// Bumped when a check starts or ends, so readers that only show a finished check read it.
let checked = 0
function checksChanged(): void {
  checked += 1
  notifyToolReaders()
}

function readsFor(bot: BotRef, agent: string | null): BotToolReads {
  const key = botRefKey(bot)
  const cached = reads.get(key)
  if (cached?.revision === toolsRevision() && cached.agent === agent) {
    return cached
  }
  if (cached) {
    stopUnfinishedChecks(cached)
  }
  listenForHostChanges()
  const ref = { hostId: bot.hostId, id: bot.id }
  const fresh: BotToolReads = {
    bot: ref,
    revision: toolsRevision(),
    agent,
    tools: callBotRpc<BotTools>(ref, 'bots.tools.list', { botId: bot.id }),
    checks: {}
  }
  reads.set(key, fresh)
  return fresh
}

/** Asks the host to stop the bot's checks still under way, and forgets them. */
function stopUnfinishedChecks(read: BotToolReads): void {
  const unfinished = CHECK_SCOPES.filter((scope) => read.checks[scope]?.done === false)
  if (unfinished.length === 0) {
    return
  }
  for (const scope of unfinished) {
    delete read.checks[scope]
  }
  void callBotRpc(read.bot, 'bots.tools.cancelProblems', { botId: read.bot.id }).catch(() => {})
  checksChanged()
}

/** Joins the scope's check, starting it if none runs; the release stops it once nobody shows it. */
function holdCheck(read: BotToolReads, scope: CheckScope): [Check, () => void] {
  let check = read.checks[scope]
  if (!check) {
    const started: Check = {
      problems: callBotRpc<{ problems: Problems }>(read.bot, 'bots.tools.problems', {
        botId: read.bot.id,
        scope
      }).then((answer) => answer.problems),
      settled: null,
      users: 0,
      done: false
    }
    void started.problems
      .then(
        (problems) => {
          started.settled = problems
        },
        () => {}
      )
      .finally(() => {
        started.done = true
        checksChanged()
      })
    read.checks[scope] = started
    check = started
    checksChanged()
  }
  const held = check
  held.users += 1
  return [
    held,
    () => {
      held.users -= 1
      const all = Object.values(read.checks)
      if (all.every((entry) => entry.users === 0)) {
        stopUnfinishedChecks(read)
      }
    }
  ]
}

/** A finished check of the bot's servers, without starting one: the widest that has finished. */
function finishedCheck(read: BotToolReads): Problems | null {
  return read.checks.all?.settled ?? read.checks.remote?.settled ?? null
}

export type BotToolsView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; tools: BotTools; problems: Record<string, BotToolProblem> }

const LOADING: BotToolsView = { status: 'loading' }

/**
 * What a reader learns of the tools' state. check: every server, as Tools shows them. apps: the URL
 * servers, only when the bot has one (the Connectors list). finished: a check someone else ran,
 * never starting one (badges, counts). none: the tools alone (Add to <bot>).
 */
export type BotToolsCheck = 'check' | 'apps' | 'finished' | 'none'

/** URL servers other than Composio's own, which is drawn as its apps. */
export function isBotAppTool(tool: BotOwnTool): boolean {
  return (tool.remote || tool.signIn !== undefined) && !COMPOSIO_SESSION_MCP_URL.test(tool.detail)
}

/** An app whose state its agent's CLI reports; one Orca signs in to has its own, and isn't checked. */
const checkedApp = (tool: BotOwnTool): boolean => isBotAppTool(tool) && tool.remote

// A tool Orca signs in to isn't checked: its state is Orca's own, so it is never unconfirmed.
const unconfirmed = (tools: readonly BotOwnTool[], detail?: string): Problems =>
  Object.fromEntries(
    tools
      .filter((tool) => !tool.signIn)
      .map((tool) => [tool.name, { kind: 'unconfirmed' as const, ...(detail ? { detail } : {}) }])
  )

/**
 * The bot's tools, then what is wrong with them (a check starts the servers, so it comes later),
 * read again when the bot changes agent; null reads nothing.
 */
export function useBotTools(
  bot: BotRef | null,
  check: BotToolsCheck = 'check'
): { view: BotToolsView } {
  const current = useSyncExternalStore(subscribe, toolsRevision)
  const finished = useSyncExternalStore(subscribe, () => (check === 'finished' ? checked : 0))
  const agent = useBots(bot !== null).find((entry) => bot && isSameBot(entry, bot))?.agent ?? null
  const [view, setView] = useState<BotToolsView>(LOADING)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  useEffect(() => {
    if (!botId || !hostId) {
      return
    }
    let live = true
    let release: (() => void) | null = null
    const ref = { hostId, id: botId }
    const read = readsFor(ref, agent)
    // Read again for a change elsewhere: the tools (and their sign-ins) update, the check stays.
    const stopListening = onToolList(
      ref,
      (tools) =>
        live && setView((shown) => (shown.status === 'ready' ? { ...shown, tools } : shown))
    )
    void read.tools.then(
      (tools) => {
        if (!live) {
          return
        }
        const own = 'own' in tools ? tools.own : []
        const scope: CheckScope | null =
          check === 'check' && own.length > 0
            ? 'all'
            : check === 'apps' && own.some(checkedApp)
              ? 'remote'
              : null
        if (!scope) {
          setView({
            status: 'ready',
            tools,
            problems: check === 'finished' ? (finishedCheck(read) ?? {}) : {}
          })
          return
        }
        setView({ status: 'ready', tools, problems: unconfirmed(own) })
        const [held, letGo] = holdCheck(read, scope)
        release = letGo
        // A check settles only the problems: the tools may have been read again since it started.
        const showProblems = (problems: Problems): void => {
          if (live) {
            setView((shown) => ({
              status: 'ready',
              tools: shown.status === 'ready' ? shown.tools : tools,
              problems
            }))
          }
        }
        void held.problems.then(showProblems, () =>
          showProblems(unconfirmed(own, 'The native check did not finish. Check again to retry.'))
        )
      },
      (error: unknown) =>
        live &&
        setView({
          status: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
    )
    return () => {
      live = false
      stopListening()
      release?.()
    }
  }, [botId, hostId, agent, check, current, finished])
  return { view: botId ? view : LOADING }
}
