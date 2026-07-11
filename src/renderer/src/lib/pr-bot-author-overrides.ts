import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { createBotAuthorOverrideSet, normalizePRCommentAuthorLogin } from './pr-comment-audience'
import { MAX_PR_BOT_AUTHOR_OVERRIDES } from '../../../shared/pr-bot-author-overrides'

let overrideUpdateQueue = Promise.resolve()

/** Normalized lookup of author logins the user manually marked as bots. */
export function usePRBotAuthorOverrides(): ReadonlySet<string> {
  const overrides = useAppStore((s) => s.settings?.prBotAuthorOverrides)
  return useMemo(() => createBotAuthorOverrideSet(overrides), [overrides])
}

/** Adds or removes a manual bot override for the given comment author. */
export function setPRBotAuthorOverride(author: string, isBot: boolean): void {
  const normalized = normalizePRCommentAuthorLogin(author)
  if (!normalized) {
    return
  }
  // Why: settings writes are asynchronous; serialize read-modify-write updates
  // so marking two authors quickly cannot make the later write drop the first.
  overrideUpdateQueue = overrideUpdateQueue
    .then(async () => {
      const { updateSettings } = useAppStore.getState()
      // Why: paired web clients have no settings push; refresh before merging so
      // a stale client cannot overwrite overrides saved by another surface.
      const settings = await window.api.settings.get()
      const current = createBotAuthorOverrideSet(settings.prBotAuthorOverrides)
      if (current.has(normalized) === isBot) {
        return
      }
      if (isBot && current.size >= MAX_PR_BOT_AUTHOR_OVERRIDES) {
        console.warn('PR bot author override limit reached')
        return
      }
      const next = new Set(current)
      if (isBot) {
        next.add(normalized)
      } else {
        next.delete(normalized)
      }
      await updateSettings({ prBotAuthorOverrides: [...next].sort() })
    })
    // Why: one failed settings write must not poison every later override update.
    .catch(() => undefined)
}
