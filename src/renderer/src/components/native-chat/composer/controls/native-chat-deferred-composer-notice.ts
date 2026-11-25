import {
  captureLaunchDraftDestination,
  currentDraftScope
} from '../../drafts/native-chat-launch-draft-source'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'

// A paste can fail after its composer was replaced (subagent view, owned prompt); the draft's next
// composer says why, so the loss is never silent. Only the latest notice per draft is kept.
const deferred = new Map<string, NativeChatComposerNoticeContent>()
const listeners = new Map<string, Set<(scope: string) => void>>()
// Failures reported but not yet published, by draft: they follow a move and end with the draft.
const routes = new Map<string, Set<NativeChatComposerNoticeRoute>>()

/** Where a reported failure is published; `retired` once its draft was deleted for good. */
export type NativeChatComposerNoticeRoute = { scopeKey: string; retired: boolean }

/** Open when the failure is reported; publication may come after an async gap. */
export function openNativeChatComposerNoticeRoute(scopeKey: string): NativeChatComposerNoticeRoute {
  const route = { scopeKey: currentDraftScope(scopeKey), retired: false }
  const scoped = routes.get(route.scopeKey) ?? new Set()
  routes.set(route.scopeKey, scoped)
  scoped.add(route)
  return route
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
}

export function deferNativeChatComposerNotice(
  scopeKey: string,
  text: string,
  errorText?: string
): void {
  scopeKey = currentDraftScope(scopeKey)
  deferred.set(scopeKey, { text, ...(errorText ? { errorText } : {}) })
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

/** A notice waiting on a draft moves with that draft's pending chips. */
export function moveDeferredNativeChatComposerNotice(from: string, to: string): void {
  from = currentDraftScope(from)
  to = currentDraftScope(to)
  if (from === to) {
    return
  }
  const notice = deferred.get(from)
  if (notice) {
    deferred.delete(from)
    deferNativeChatComposerNotice(to, notice.text, notice.errorText)
  }
  const moving = routes.get(from)
  if (moving) {
    routes.delete(from)
    const scoped = routes.get(to) ?? new Set()
    routes.set(to, scoped)
    for (const route of moving) {
      route.scopeKey = to
      scoped.add(route)
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
