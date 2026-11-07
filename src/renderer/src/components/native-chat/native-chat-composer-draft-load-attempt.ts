import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import type { AppendBeforeLoad, UnconfirmedDraftChange } from './native-chat-composer-draft-memory'

export type NativeChatDraftLoadExclusions = {
  values: ReadonlyMap<string, ReadonlySet<string>>
  journal: ReadonlySet<string>
}
export type NativeChatDraftLoadAttempt = {
  installed: WeakMap<
    StoredNativeChatComposerDraft,
    {
      input: unknown
      journal: ReadonlySet<string>
      appends: readonly AppendBeforeLoad[]
      write?: UnconfirmedDraftChange
    }
  >
  exclusions: Set<NativeChatDraftLoadExclusions>
}
const active = new Set<NativeChatDraftLoadAttempt>()
const observers = new Set<(attempt: NativeChatDraftLoadAttempt) => void>()

export function beginNativeChatDraftLoadAttempt(): NativeChatDraftLoadAttempt {
  const attempt: NativeChatDraftLoadAttempt = { installed: new WeakMap(), exclusions: new Set() }
  active.add(attempt)
  observers.forEach((observe) => observe(attempt))
  return attempt
}
export function finishNativeChatDraftLoadAttempt(attempt: NativeChatDraftLoadAttempt): void {
  active.delete(attempt)
  attempt.exclusions.clear()
}

/** A finite removal also sees retries begun while its membership/storage work is pending. */
export function captureNativeChatDraftLoadLifetime(exclusions: NativeChatDraftLoadExclusions) {
  const attempts = new Set<NativeChatDraftLoadAttempt>()
  const observe = (attempt: NativeChatDraftLoadAttempt) => {
    attempts.add(attempt)
    attempt.exclusions.add(exclusions)
  }
  active.forEach(observe)
  observers.add(observe)
  return {
    attempts,
    dispose: () => {
      observers.delete(observe)
      if (exclusions.values.size === 0 && exclusions.journal.size === 0) {
        attempts.forEach((attempt) => attempt.exclusions.delete(exclusions))
      }
      attempts.clear()
    }
  }
}
