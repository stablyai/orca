import { useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  createBotAuthorOverrideSet,
  MAX_PR_BOT_AUTHOR_OVERRIDES,
  normalizePRCommentAuthorLogin
} from '../../../shared/pr-bot-author-overrides'

let overrideUpdateQueue = Promise.resolve()

export function usePRBotAuthorOverrides(): ReadonlySet<string> {
  const overrides = useAppStore((s) => s.settings?.prBotAuthorOverrides)
  return useMemo(() => createBotAuthorOverrideSet(overrides), [overrides])
}

export function setPRBotAuthorOverride(author: string, isBot: boolean): void {
  const normalized = normalizePRCommentAuthorLogin(author)
  if (!normalized) {
    return
  }
  // Serialize async read/modify/write updates so rapid bot markings cannot lose one another.
  overrideUpdateQueue = overrideUpdateQueue
    .then(async () => {
      // Keep atomic modification in the authoritative store so desktop/paired clients cannot overwrite concurrent changes.
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
    // A failed write must not poison later override updates.
    .catch(() => undefined)
}
