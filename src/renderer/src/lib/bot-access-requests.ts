// People asking the account's bots for access, as Orca Cloud lists them. The owner reviews a request
// in the bot's People with access, which confirms first; the host's bots.access.decide adds the person.
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import type {
  BotAccessDecision,
  ConnectorAccessRequest
} from '../../../shared/connector-bot-access-contract'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../../shared/connector-bot-slack-contract'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { BOT_ACCESS_COPY } from '../../../shared/bots/bot-access-copy'
import { readBots, readBotsEnabled, refreshBotHost } from './bot-catalog'
import { onBotsChanged } from './bots-changed-window-event'
import { botHostTarget, forEachBotHost } from './bot-hosts'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

/** A request as a host listed it: answered on that host, for that host's bot. */
export type HostAccessRequest = ConnectorAccessRequest & { hostId: ExecutionHostId }

const NO_REQUESTS: readonly HostAccessRequest[] = []

let requests: readonly HostAccessRequest[] = NO_REQUESTS
// Each host's last listed requests; `requests` is them all, less what this run answered.
const listedByHost = new Map<ExecutionHostId, readonly HostAccessRequest[]>()
// The request the owner's link opened, until its bot's People with access asks about it.
let review: HostAccessRequest | null = null
// Answered this run, while the cloud may still list them.
const decided = new Set<string>()
// Per host, every request this window has listed, so it toasts each once; absent until the host
// first answers, which is silent. A failed read is no answer; signed out is one, of no requests.
const seenByHost = new Map<ExecutionHostId, Set<string>>()
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function openBotWhoCanAsk(botId: string): void {
  openBotSettings(botId, 'who-can-ask')
}

function sameRequest(a: HostAccessRequest, b: HostAccessRequest): boolean {
  return a.hostId === b.hostId && a.requestId === b.requestId
}

/** Opens the bot's People with access on this request, where the owner decides. */
export function reviewAccessRequest(request: HostAccessRequest): void {
  review = request
  if (!requests.some((entry) => sameRequest(entry, request))) {
    requests = [request, ...requests]
  }
  publish()
  openBotWhoCanAsk(request.botId)
}

// One toast for what this window had not listed before: the request itself, or how many asked.
function announce(fresh: readonly HostAccessRequest[]): void {
  const bots = readBots()
  const botOf = (request: HostAccessRequest) =>
    bots.find((bot) => bot.id === request.botId && bot.hostId === request.hostId)
  const unseen = fresh.filter((request) => botOf(request))
  const [first] = unseen
  if (!first) {
    return
  }
  if (unseen.length > 1) {
    toast.info(
      translate('bots.accessRequest.toastMany', '{{count}} people asked for access to your bots', {
        count: unseen.length
      }),
      {
        action: {
          label: translate('bots.accessRequest.review', 'Review'),
          onClick: () => openBotWhoCanAsk(first.botId)
        }
      }
    )
    return
  }
  toast.info(
    translate('bots.accessRequest.toast', '{{person}} asked for access to {{name}}', {
      person: first.requester.name || first.requester.handle,
      name: botOf(first)?.name ?? ''
    }),
    {
      action: {
        label: translate('bots.accessRequest.review', 'Review'),
        onClick: () => reviewAccessRequest(first)
      }
    }
  )
}

function show(hostId: ExecutionHostId, listed: readonly HostAccessRequest[]): void {
  listedByHost.set(hostId, listed)
  // A read that started before the owner answered must not bring the request back.
  requests = [...listedByHost.values()].flat().filter((request) => !decided.has(request.requestId))
  if (review && !requests.some((request) => review && sameRequest(request, review))) {
    review = null
  }
  publish()
}

/** Reads one host's waiting requests, and toasts the ones this window has not listed before. */
async function refreshHostAccessRequests(hostId: ExecutionHostId): Promise<void> {
  const result = await callRuntimeRpc<BotSlackResult<ConnectorAccessRequest[]>>(
    botHostTarget(hostId),
    'bots.access.list'
  ).catch(() => null)
  if (!result) {
    return
  }
  if (!result.ok) {
    // Another account's requests must not stay actionable here.
    if (result.error === 'signed_out') {
      if (!seenByHost.has(hostId)) {
        seenByHost.set(hostId, new Set())
      }
      show(hostId, NO_REQUESTS)
    }
    return
  }
  const listed = result.value.map((request) => ({ ...request, hostId }))
  const known = seenByHost.get(hostId)
  seenByHost.set(hostId, new Set([...(known ?? []), ...listed.map((request) => request.requestId)]))
  show(hostId, listed)
  if (known) {
    announce(
      requests.filter((request) => request.hostId === hostId && !known.has(request.requestId))
    )
  }
}

/** Reads every listed host's waiting requests. */
export async function refreshAccessRequests(): Promise<void> {
  await forEachBotHost(({ hostId }) => refreshHostAccessRequests(hostId))
}

/** Re-reads a host on its botsChanged, which its watcher sends when the waiting list changes. */
export function watchAccessRequests(): () => void {
  if (readBotsEnabled()) {
    void refreshAccessRequests()
  }
  // The app's botsChanged subscriptions re-emit each host's on the window.
  return onBotsChanged(
    (hostId) => {
      if (readBotsEnabled()) {
        void refreshHostAccessRequests(hostId)
      }
    },
    undefined,
    { kinds: ['access'] }
  )
}

/** Closes a request on the host, as a paired phone does: Grant also adds its person to the bot's list. */
export async function decideAccessRequest(
  request: HostAccessRequest,
  decision: BotAccessDecision
): Promise<void> {
  decided.add(request.requestId)
  requests = requests.filter((entry) => !sameRequest(entry, request))
  if (review && sameRequest(review, request)) {
    review = null
  }
  publish()
  const result = await callRuntimeRpc<BotSlackResult<undefined>>(
    botHostTarget(request.hostId),
    'bots.access.decide',
    { requestId: request.requestId, decision }
  ).catch((): BotSlackResult<undefined> => ({
    ok: false,
    error: BOT_SLACK_DESKTOP_ERRORS.unreachable
  }))
  if (decision === 'granted') {
    await refreshBotHost(request.hostId)
  }
  // An expired request is closed anyway; any other failure keeps it to answer again.
  if (!result.ok && result.error !== 'expired') {
    decided.delete(request.requestId)
    requests = [request, ...requests]
    publish()
    toast.error(translate('bots.accessRequest.decideFailed', BOT_ACCESS_COPY.decideFailed))
  }
}

/** Takes the request the owner's link opened, once, if it is one of `matches`. */
export function takeAccessReview(
  matches: (request: HostAccessRequest) => boolean
): HostAccessRequest | null {
  const taken = review && matches(review) ? review : null
  if (taken) {
    review = null
  }
  return taken
}

const readRequests = (): readonly HostAccessRequest[] => requests
const readReview = (): HostAccessRequest | null => review

export function useAccessRequests(): readonly HostAccessRequest[] {
  return useSyncExternalStore(subscribe, readRequests)
}

export function useAccessReview(): HostAccessRequest | null {
  return useSyncExternalStore(subscribe, readReview)
}
