import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'

// Chat roots whose focused composer, holding unsent text, went away in the current commit.
const rootsLeftMidDraft = new WeakSet<Element>()

/** Called as a composer unmounts: a card replacing a focused draft must not put its keys on an answer. */
export function noteComposerLeavingWithDraft(active: Element | null, draft: string): void {
  const root = active?.closest(NATIVE_CHAT_ROOT_SELECTOR)
  if (!root || draft.trim() === '') {
    return
  }
  rootsLeftMidDraft.add(root)
  // Only a card mounted in the same commit is replacing that composer.
  queueMicrotask(() => rootsLeftMidDraft.delete(root))
}

export function replacesComposerMidDraft(card: HTMLElement): boolean {
  const root = card.closest(NATIVE_CHAT_ROOT_SELECTOR)
  return root !== null && rootsLeftMidDraft.has(root)
}
