// An ask's answers held on this device until they post: a draft per question line in the composer's
// store (so a reload keeps them), its words and the images they name, [Image #1] its first.
import { useMemo, useSyncExternalStore } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemHeldAnswer } from '../../../../../shared/bots/bot-item-answer-lines'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'

export function botItemHeldAnswerScope(
  bot: Bot,
  itemUid: string,
  askId: string,
  line: number
): string {
  return `bot-item-answers:${botRefKey(bot)}:${itemUid}:${askId}:${line}`
}

export function readBotItemHeldAnswer(scope: string): BotItemHeldAnswer | null {
  const draft = readNativeChatComposerDraft(scope)
  const paths = draft.images.map((image) => image.path)
  return draft.text.trim() || paths.length > 0 ? { words: draft.text.trim(), paths } : null
}

/** Holds a line's answer, or lets it go (null). */
export function holdBotItemAnswer(scope: string, answer: BotItemHeldAnswer | null): void {
  const kept = readNativeChatComposerDraft(scope).images
  const images = (answer?.paths ?? []).map(
    (path) =>
      kept.find((image) => image.path === path) ?? { id: createNonSecureContextUuid(), path }
  )
  updateNativeChatComposerDraft(
    scope,
    { text: answer?.words ?? '', document: undefined, images },
    'immediate'
  )
}

/** The answers held in `scopes`, in their order; read again when any of them changes. */
export function useBotItemHeldAnswers(
  scopes: readonly string[]
): readonly (BotItemHeldAnswer | null)[] {
  const joined = scopes.join('\n')
  const store = useMemo(() => {
    const keys = joined ? joined.split('\n') : []
    let drafts: readonly unknown[] = []
    let held: readonly (BotItemHeldAnswer | null)[] = []
    return {
      subscribe: (listener: () => void) => {
        const stops = keys.map((key) => subscribeToNativeChatComposerDraft(key, listener))
        return () => stops.forEach((stop) => stop())
      },
      // The same answers while no draft changed, as the store's records are.
      read: () => {
        const next = keys.map((key) => readNativeChatComposerDraft(key))
        if (next.length !== drafts.length || next.some((draft, at) => draft !== drafts[at])) {
          drafts = next
          held = keys.map((key) => readBotItemHeldAnswer(key))
        }
        return held
      }
    }
  }, [joined])
  return useSyncExternalStore(store.subscribe, store.read)
}
