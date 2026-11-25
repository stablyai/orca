// The one owner of "which computer runs this bot": bot code reaches a host only through these.
import { useMemo } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { readBotHostIds, readLiveBotHostIds } from './bot-catalog-snapshot'

/** A bot as listed, stamped with the host that listed it. Ids are random per host, so never a bare id. */
export type BotOnHost = { readonly hostId: ExecutionHostId }

/** A listed bot: its id names it only on the host it carries. */
export type BotRef = BotOnHost & { readonly id: string }

/** A key for maps of bots across hosts: the same id on two hosts is two bots. */
export function botRefKey(bot: BotRef): string {
  return `${bot.hostId}\u0000${bot.id}`
}

/** Whether `bot` is the bot `ref` names. */
export function isSameBot(bot: BotRef, ref: BotRef): boolean {
  return bot.id === ref.id && bot.hostId === ref.hostId
}

/**
 * The bot's ref, kept while its host and id stay the same. A list re-read gives every bot a new
 * object, so effects and memos about one bot key on this, never on the bot itself.
 */
export function useStableBotRef(bot: BotRef): BotRef {
  const { hostId, id } = bot
  return useMemo(() => ({ hostId, id }), [hostId, id])
}

export type BotHost = { hostId: ExecutionHostId; target: RuntimeClientTarget }

// One target object per host, so hooks keyed on a target never resubscribe on a render.
const targets = new Map<ExecutionHostId, RuntimeClientTarget>()

function targetFor(hostId: ExecutionHostId): RuntimeClientTarget {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return { kind: 'local' }
  }
  if (parsed?.kind === 'runtime') {
    return { kind: 'environment', environmentId: parsed.environmentId }
  }
  // This app serves no SSH route, so an SSH-hosted bot has no host to call yet.
  throw new Error(`No bot host at ${hostId}`)
}

/** The transport to a host that runs bots: this app's own runtime, or a paired server's. */
export function botHostTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  let target = targets.get(hostId)
  if (!target) {
    target = targetFor(hostId)
    targets.set(hostId, target)
  }
  return target
}

/** Where every call about one bot goes. */
export function botTarget(bot: BotOnHost): RuntimeClientTarget {
  return botHostTarget(bot.hostId)
}

/** A runtime call about one bot, on the host that runs it. */
export function callBotRpc<TResult>(
  bot: BotOnHost,
  method: string,
  ...rest: [params?: unknown, options?: Parameters<typeof callRuntimeRpc>[3]]
): Promise<TResult> {
  return callRuntimeRpc<TResult>(botTarget(bot), method, ...rest)
}

/**
 * This app's own bot host, for the surfaces that show one computer's bot accounts with no bot in
 * hand (Settings › Bots accounts, the Composio key, shared links) and where New bot creates.
 */
export function ownBotHost(): BotHost {
  return { hostId: LOCAL_EXECUTION_HOST_ID, target: botHostTarget(LOCAL_EXECUTION_HOST_ID) }
}

/** Whether `hostId`'s bots are listed here, a disconnected server's last read included. */
export function isListedBotHost(hostId: ExecutionHostId): boolean {
  return readBotHostIds().includes(hostId)
}

/** The listed bot hosts that can be called now, in sidebar order; a disconnected server is left out. */
export function listBotHosts(): BotHost[] {
  return readLiveBotHostIds().map((hostId) => ({ hostId, target: botHostTarget(hostId) }))
}

/**
 * Runs `fn` on every connected bot host at once, for what belongs to a computer rather than a bot
 * (access requests, accounts, the Composio key). A host that throws is left out, so one
 * unreachable host never hides the others.
 */
export async function forEachBotHost<T>(
  fn: (host: BotHost) => Promise<T> | T
): Promise<{ host: BotHost; value: T }[]> {
  const hosts = listBotHosts()
  const settled = await Promise.allSettled(hosts.map(async (host) => fn(host)))
  return settled.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{ host: hosts[index], value: result.value }] : []
  )
}
