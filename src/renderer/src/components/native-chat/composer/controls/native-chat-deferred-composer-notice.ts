import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'
import type { NativeChatComposerNoticeContent } from './native-chat-composer-notice'

// A paste can fail after its composer was replaced (subagent view, owned prompt); the draft's next
// composer says why, so the loss is never silent. Only the latest notice per draft is kept.
const deferred = new Map<string, NativeChatComposerNoticeContent>()
const listeners = new Map<string, Set<() => void>>()

export function deferNativeChatComposerNotice(
  scopeKey: string,
  text: string,
  errorText?: string
): void {
  scopeKey = currentDraftScope(scopeKey)
  deferred.set(scopeKey, { text, ...(errorText ? { errorText } : {}) })
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

/** Hands the draft's waiting notice to `show` once, now or when one arrives. */
export function takeDeferredNativeChatComposerNotices(
  scopeKey: string,
  show: (notice: NativeChatComposerNoticeContent) => void
): () => void {
  scopeKey = currentDraftScope(scopeKey)
  const listener = (): void => {
    const notice = deferred.get(scopeKey)
    if (notice) {
      deferred.delete(scopeKey)
      show(notice)
    }
  }
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  listener()
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0 && listeners.get(scopeKey) === scoped) {
      listeners.delete(scopeKey)
    }
  }
}
