// A bot made from a link, under its name in the settings header: who shared it and when, and its original.
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'
import { botShareErrorMessage } from '../sharing/bot-share-error-copy'
import { reviewBotShare } from '../sharing/bot-share-rpc'
import { BotShareReviewDialog } from '../sharing/BotShareReviewDialog'

/** "Shared by Dara · Nov 8 · View original": the original shows read-only while its link still serves it.
 *  A long name truncates; View original always stays whole. */
export function BotSharedFromLine({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [original, setOriginal] = useState<BotShareReview | 'gone' | 'loading' | null>(null)
  const from = bot.sharedFrom
  if (!from) {
    return null
  }
  const sharedAt = new Date(from.sharedAt)
  const by = t('bots.share.copy.sharedBy', 'Shared by {{who}}', {
    who: from.sharedBy ?? t('bots.share.review.someone', 'Someone')
  })
  const date = Number.isNaN(sharedAt.getTime())
    ? null
    : uiDateTimeFormat({ month: 'short', day: 'numeric' }, locale).format(sharedAt)
  const viewOriginal = (): void => {
    setOriginal('loading')
    reviewBotShare(from.shareId, from.versionId).then(
      (review) => setOriginal(review ?? 'gone'),
      (error: unknown) => {
        setOriginal(null)
        toast.error(botShareErrorMessage(error))
      }
    )
  }
  return (
    // The sharer's name truncates; the date and View original never do, and move under it when it is long.
    <span className="flex flex-wrap items-baseline gap-x-1 text-xs leading-4 text-muted-foreground">
      <span className="max-w-full min-w-0 truncate" title={by}>
        {by}
      </span>
      <span className="flex shrink-0 items-baseline gap-x-1">
        {date ? <span>· {date}</span> : null}
        <span aria-hidden>·</span>
        {original === 'gone' ? (
          <span role="status">{t('bots.share.copy.originalGone', 'No longer available')}</span>
        ) : (
          <Button
            variant="link"
            size="inlineText"
            disabled={original === 'loading'}
            onClick={viewOriginal}
          >
            {t('bots.share.copy.viewOriginal', 'View original')}
          </Button>
        )}
      </span>
      {original && typeof original === 'object' ? (
        <BotShareReviewDialog review={original} readOnly onClose={() => setOriginal(null)} />
      ) : null}
    </span>
  )
}
