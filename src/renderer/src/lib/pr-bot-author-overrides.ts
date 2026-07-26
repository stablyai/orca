import { useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
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
      // Why: the authoritative store owns the read-modify-write so concurrent
      // desktop and paired-web clients cannot overwrite each other's updates.
      const settings = await window.api.settings.updatePRBotAuthorOverride({
        author: normalized,
        isBot
      })
      useAppStore.setState({ settings })
      const current = createBotAuthorOverrideSet(settings.prBotAuthorOverrides)
      if (isBot && !current.has(normalized) && current.size >= MAX_PR_BOT_AUTHOR_OVERRIDES) {
        toast.warning(
          translate(
            'auto.lib.pr.bot.author.overrides.6d5d52b53f',
            'Bot author override limit reached'
          )
        )
      }
    })
    // Why: one failed settings write must not poison every later override update.
    .catch(() => undefined)
}
