// Avatar generation runs, kept outside React: a run outlives the picker (and the dialog or settings view)
// that asked for it, and its picture lands on the bot it was asked for, once, unless a newer choice was
// made since. A picture for a bot that exists is uploaded only here, and only behind the host's revision
// check, so it can never overwrite a picture or color set after Generate was pressed.
import { useSyncExternalStore } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent,
  GeneratedAvatarImage
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { avatarPngFromBlob } from './bot-avatar-intake'
import { avatarGenerationApi, setAvatarAgentStatus } from './avatar-generation-capability-store'
import { rememberGeneratedPicture } from './generated-avatar-descriptions'
import { subscribeBotPictureEvents, type BotPictureEvent } from './bot-picture-ops'
import {
  anchorAt,
  canCheckRevision,
  catalogRevision,
  failedForToast,
  tryApply as tryApplyWith,
  type AvatarRequestHost,
  type AvatarRequestOwner,
  type GeneratedAvatar,
  type Owner,
  type Request
} from './avatar-generation-request-apply'

export type {
  AvatarRequestHost,
  AvatarRequestOwner,
  GeneratedAvatar
} from './avatar-generation-request-apply'

const requests = new Map<string, Request>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function ownerKey(owner: Owner): string {
  return owner.kind === 'bot' ? botRefKey(owner.ref) : owner.key
}

function finish(request: Request): void {
  if (requests.get(request.id) === request) {
    requests.delete(request.id)
    notify()
  }
}

function cancelRun(request: Request): void {
  finish(request)
  void avatarGenerationApi()
    ?.cancel({ requestId: request.id })
    .catch(() => {})
}

function tryApply(request: Request): void {
  tryApplyWith(request, finish)
}

function land(request: Request, made: GeneratedAvatar): void {
  request.made = made
  if (request.owner.kind === 'draft') {
    finish(request)
    request.host?.landed(made, request.eligible)
    return
  }
  request.status = 'landed'
  if (request.owner.kind === 'creating') {
    // Held until Create settles.
    return
  }
  request.host?.landed(made, false)
  tryApply(request)
}

function fail(request: Request, failure: AvatarGenerationFailure): void {
  if (requests.get(request.id) !== request) {
    return
  }
  if (request.owner.kind === 'creating') {
    request.status = 'failed'
    request.failure = failure
    return
  }
  finish(request)
  if (request.host) {
    request.host.failed(failure, request.agent)
  } else if (request.owner.kind === 'bot') {
    failedForToast(request.owner.name)
  }
}

function imageBlob(image: GeneratedAvatarImage): Blob {
  const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: image.mimeType })
}

function onPictureEvent(event: BotPictureEvent): void {
  for (const request of requests.values()) {
    if (request.owner.kind === 'creating' || ownerKey(request.owner) !== event.key) {
      continue
    }
    const anchor = request.anchor
    if (event.kind === 'choice') {
      request.eligible = false
      tryApply(request)
    } else if (anchor?.waiting && event.kind === 'ack') {
      anchor.acked = Math.max(anchor.acked, event.revision)
    } else if (anchor?.waiting && event.kind === 'failed') {
      anchor.failed = true
    } else if (anchor?.waiting && event.kind === 'idle' && request.owner.kind === 'bot') {
      // A save that failed has no revision to wait for; the catalog's, after it settles, stands in.
      anchor.revision = Math.max(
        anchor.revision,
        anchor.acked,
        anchor.failed ? catalogRevision(request.owner.ref) : 0
      )
      anchor.waiting = false
      tryApply(request)
    }
  }
}

let unsubscribeLedger: (() => void) | null = null

/** Starts a run; the id it returns names it to the calls below. */
export function startAvatarRequest({
  description,
  agent,
  owner,
  host
}: {
  description: string
  agent: AvatarImageAgent
  owner: AvatarRequestOwner
  host: AvatarRequestHost
}): string | null {
  const api = avatarGenerationApi()
  if (!api) {
    return null
  }
  unsubscribeLedger ??= subscribeBotPictureEvents(onPictureEvent)
  const id = createNonSecureContextUuid()
  const request: Request = {
    id,
    description,
    agent,
    status: 'running',
    made: null,
    failure: null,
    owner:
      owner.kind === 'bot'
        ? { kind: 'bot', ref: { hostId: owner.bot.hostId, id: owner.bot.id }, name: owner.bot.name }
        : owner,
    eligible: true,
    host,
    anchor: owner.kind === 'bot' ? anchorAt(owner.bot) : null
  }
  requests.set(id, request)
  notify()
  void api.generate({ requestId: id, description, agent }).then(
    async (outcome) => {
      if (requests.get(id) !== request) {
        return
      }
      if (!outcome.ok) {
        if (outcome.error === 'canceled') {
          finish(request)
          request.host?.ended()
          return
        }
        if (outcome.error === 'signed-out') {
          setAvatarAgentStatus(agent, 'signed-out')
        }
        fail(request, outcome.error)
        return
      }
      // A run that worked proves the agent ready, whatever an older probe said.
      setAvatarAgentStatus(outcome.agent, 'ready')
      // The same square crop an upload gets, so what shows is exactly what saves.
      const png = await avatarPngFromBlob(imageBlob(outcome.image)).catch(() => null)
      if (requests.get(id) !== request) {
        return
      }
      if (!png) {
        fail(request, 'no-image')
        return
      }
      rememberGeneratedPicture(png, description)
      land(request, { png, description })
    },
    () => fail(request, 'failed')
  )
  return id
}

export function cancelAvatarRequest(id: string): void {
  const request = requests.get(id)
  if (request && request.status === 'running') {
    cancelRun(request)
  }
}

/** The host that asked is going away. A run for a bot not yet made ends with it; one for a bot that
 *  exists keeps going, if its host can check the revision, and lands on its own. */
export function releaseAvatarRequest(id: string): void {
  const request = requests.get(id)
  if (!request) {
    return
  }
  request.host = null
  if (request.owner.kind === 'draft') {
    cancelRun(request)
    return
  }
  if (request.owner.kind === 'bot' && request.status === 'running') {
    if (!canCheckRevision(request.owner.ref)) {
      cancelRun(request)
      failedForToast(request.owner.name)
    }
  }
}

/** Create captured the dialog's picture: a run still going is now for the bot being made. Null when there
 *  is none, or it can't follow (a newer choice was made, or the host can't check the revision). */
export function handOffAvatarRequest(
  id: string | null,
  target: { hostId: BotRef['hostId']; name: string }
): { created: (bot: Bot) => void; failed: () => void } | null {
  const request = id ? requests.get(id) : undefined
  if (!request || request.owner.kind !== 'draft' || request.status !== 'running') {
    return null
  }
  if (!request.eligible) {
    // The picture submitted is the newer choice.
    cancelRun(request)
    return null
  }
  if (!botHostHas(target.hostId, BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY)) {
    cancelRun(request)
    failedForToast(target.name)
    return null
  }
  const draftKey = request.owner.key
  request.owner = { kind: 'creating', key: draftKey, name: target.name }
  let settled = false
  return {
    created: (bot) => {
      if (settled || requests.get(request.id) !== request) {
        return
      }
      settled = true
      request.owner = { kind: 'bot', ref: { hostId: bot.hostId, id: bot.id }, name: bot.name }
      // The bot as Create (and its first picture's upload) acknowledged it.
      request.anchor = { revision: bot.avatarRevision ?? 0, waiting: false, acked: 0, failed: false }
      notify()
      if (request.status === 'failed') {
        finish(request)
        failedForToast(bot.name)
        return
      }
      tryApply(request)
    },
    failed: () => {
      if (settled || requests.get(request.id) !== request) {
        return
      }
      settled = true
      // Back to the dialog, still open: the picture is placed there, and a retried Create submits it.
      request.owner = { kind: 'draft', key: draftKey }
      if (request.status === 'landed' && request.made) {
        land(request, request.made)
      } else if (request.status === 'failed' && request.failure) {
        request.status = 'running'
        fail(request, request.failure)
      }
    }
  }
}

function botGenerating(key: string): boolean {
  for (const request of requests.values()) {
    if (request.owner.kind === 'bot' && botRefKey(request.owner.ref) === key) {
      return true
    }
  }
  return false
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether a picture is being made for the bot, from any picker in this window, open or closed. */
export function useBotPictureGenerating(bot: BotRef): boolean {
  const key = botRefKey(bot)
  return useSyncExternalStore(subscribe, () => botGenerating(key))
}

/** For tests: forget every run. */
export function resetAvatarRequestsForTests(): void {
  requests.clear()
  unsubscribeLedger?.()
  unsubscribeLedger = null
  notify()
}
