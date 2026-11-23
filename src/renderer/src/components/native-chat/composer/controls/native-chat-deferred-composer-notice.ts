import {
  captureLaunchDraftDestination,
  currentDraftScope
} from '../../drafts/native-chat-launch-draft-source'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'

// A paste can fail after its composer was replaced (subagent view, owned prompt); the draft's next
// composer says why, so the loss is never silent. Only the latest notice per draft is kept.
const deferred = new Map<string, NativeChatComposerNoticeContent>()
const listeners = new Map<string, Set<(scope: string) => void>>()

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
  const notice = deferred.get(from)
  if (notice && from !== to) {
    deferred.delete(from)
    deferNativeChatComposerNotice(to, notice.text, notice.errorText)
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
