// A received link's review, laid out as the Share dialog's pages: the same part names and flag spots,
// with every file read from the review instead of a candidate.
import { getIntlLocale, translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'
import { BOT_CONNECTORS } from '../bot-connectors'
import type { BotSharePage } from './bot-share-pages'

export type BotShareReviewList =
  | 'skills'
  | 'automations'
  | 'tools'
  | 'accounts'
  | 'memory'
  | 'check'
  | 'leftOut'

export type BotShareReviewPage =
  | { kind: 'list'; list: BotShareReviewList }
  | Extract<BotSharePage, { kind: 'part' }>

/** The review page that shows a flag; the Share dialog's setup-note page is Accounts to connect here. */
export function reviewFlagPage(page: BotSharePage | null): BotShareReviewPage | null {
  if (!page) {
    return null
  }
  if (page.kind === 'list') {
    return { kind: 'list', list: 'accounts' }
  }
  // A skill's page is the skill, as its row in Skills opens it.
  return page.part.startsWith('skill:')
    ? { ...page, title: page.part.slice('skill:'.length), showNames: true }
    : page
}

/** "GitHub, Slack": the accounts a bot made from the link asks its owner to connect. */
export function reviewAccounts(review: BotShareReview): string[] {
  return review.bot.connectors.map(
    ({ kind }) =>
      BOT_CONNECTORS.find((connector) => connector.id === kind)?.label ??
      (kind === 'composio' ? 'Composio' : kind)
  )
}

/** "Dara · Nov 8, 2026 · Not reviewed": who shared it and when, from their account. */
export function reviewByline(review: BotShareReview): string {
  const date = uiDateTimeFormat(
    { month: 'short', day: 'numeric', year: 'numeric' },
    getIntlLocale()
  ).format(new Date(review.publishedAt))
  return translate('bots.share.review.byline', '{{who}} · {{date}} · Not reviewed', {
    who: review.publisher ?? translate('bots.share.review.someone', 'Someone'),
    date
  })
}
