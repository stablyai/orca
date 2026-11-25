import {
  captureLaunchDraftDestination,
  currentDraftScope
} from '../../drafts/native-chat-launch-draft-source'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'
import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'

// A paste can fail after its composer was replaced (subagent view, owned prompt); the draft's next
// composer says why, so the loss is never silent. Only the latest notice per draft is kept.
const deferred = new Map<string, NativeChatComposerNoticeContent>()
const listeners = new Map<string, Set<(scope: string) => void>>()
// Failures reported but not yet published, by draft: they follow a move and end with the draft.
const routes = new Map<string, Set<NativeChatComposerNoticeRoute>>()
// The workspace of each draft holding a notice or route. Once the draft's last chip is gone this may be
// the only record of its owner, and removing the workspace finds the draft by owner.
const owners = new Map<string, NativeChatComposerDraftOwner>()

/** Where a reported failure is published; `retired` once its draft was deleted for good. */
export type NativeChatComposerNoticeRoute = {
  scopeKey: string
  retired: boolean
  owner?: NativeChatComposerDraftOwner
}

/** Open while the chip is still in its draft, so the draft's owner is known; publication may come later. */
export function openNativeChatComposerNoticeRoute(
  scopeKey: string,
  owner?: NativeChatComposerDraftOwner
): NativeChatComposerNoticeRoute {
  const route = { scopeKey: currentDraftScope(scopeKey), retired: false, owner }
  const scoped = routes.get(route.scopeKey) ?? new Set()
  routes.set(route.scopeKey, scoped)
  scoped.add(route)
  if (owner) {
    owners.set(route.scopeKey, owner)
  }
  return route
}

function forgetOwnerIfIdle(scopeKey: string): void {
  if (!deferred.has(scopeKey) && !routes.has(scopeKey)) {
    owners.delete(scopeKey)
  }
}

export function deferredNativeChatComposerNoticeOwner(
  scopeKey: string
): NativeChatComposerDraftOwner | undefined {
  return owners.get(scopeKey)
}

/** Call at publication; returns the draft to publish to, or null if that draft is gone. */
export function closeNativeChatComposerNoticeRoute(
  route: NativeChatComposerNoticeRoute
): string | null {
  const scoped = routes.get(route.scopeKey)
  scoped?.delete(route)
  if (scoped?.size === 0) {
    routes.delete(route.scopeKey)
  }
  forgetOwnerIfIdle(route.scopeKey)
  return route.retired ? null : route.scopeKey
}

export function deferredNativeChatComposerNoticeScopes(): string[] {
  return [...new Set([...deferred.keys(), ...routes.keys()])]
}

/** The draft is gone for good: its waiting notice and any still being reported go with it. */
export function retireDeferredNativeChatComposerNotices(scopeKey: string): void {
  deferred.delete(scopeKey)
  for (const route of routes.get(scopeKey) ?? []) {
    route.retired = true
  }
  routes.delete(scopeKey)
  owners.delete(scopeKey)
}

export function deferNativeChatComposerNotice(
  scopeKey: string,
  text: string,
  errorText?: string,
  owner?: NativeChatComposerDraftOwner
): void {
  scopeKey = currentDraftScope(scopeKey)
  deferred.set(scopeKey, { text, ...(errorText ? { errorText } : {}) })
  if (owner) {
    owners.set(scopeKey, owner)
  }
  listeners.get(scopeKey)?.forEach((listener) => listener(scopeKey))
}

/** Hands the draft's waiting notice to `show` once, now or when one arrives. */
export function takeDeferredNativeChatComposerNotices(
  scopeKey: string,
  show: (notice: NativeChatComposerNoticeContent) => void
): () => void {
  const destination = captureLaunchDraftDestination(scopeKey)
  scopeKey = currentDraftScope(scopeKey)
  const listener = (scope: string): void => {
    const notice = deferred.get(scope)
    if (notice) {
      deferred.delete(scope)
      forgetOwnerIfIdle(scope)
      show(notice)
    }
  }
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  listener(scopeKey)
  return () => {
    const key = destination?.scopeKey ?? scopeKey
    const current = listeners.get(key)
    current?.delete(listener)
    if (current?.size === 0) {
      listeners.delete(key)
    }
  }
}

/** A notice waiting on a draft moves with that draft's pending chips, taking on its new owner. */
export function moveDeferredNativeChatComposerNotice(
  from: string,
  to: string,
  owner?: NativeChatComposerDraftOwner
): void {
  from = currentDraftScope(from)
  to = currentDraftScope(to)
  if (from === to) {
    return
  }
  owner ??= owners.get(from)
  owners.delete(from)
  const notice = deferred.get(from)
  if (notice) {
    deferred.delete(from)
    deferNativeChatComposerNotice(to, notice.text, notice.errorText, owner)
  }
  const moving = routes.get(from)
  if (moving) {
    routes.delete(from)
    const scoped = routes.get(to) ?? new Set()
    routes.set(to, scoped)
    for (const route of moving) {
      route.scopeKey = to
      route.owner = owner ?? route.owner
      scoped.add(route)
    }
    if (owner) {
      owners.set(to, owner)
    }
  }
}

export function moveLaunchDeferredNativeChatComposerNoticeListeners(
  from: string,
  to: string
): void {
  const source = listeners.get(from)
  if (source) {
    listeners.set(to, new Set([...(listeners.get(to) ?? []), ...source]))
    listeners.delete(from)
  }
}
