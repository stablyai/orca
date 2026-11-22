// A received link's review: who shared it, the safety check, and one line per part, every line
// drilling in to the exact text Create writes. Nothing is created until Create bot….
import { useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isBotMascotId } from '../../../../../shared/bot-avatar'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'
import { BOT_MASCOT_URLS } from '../bot-mascots'
import { BotAvatarTile } from '../BotAvatar'
import { botShareCheckSummary, botShareFlagLabel, botShareFlagPage } from './bot-share-flags'
import type { BotShareFlagSpot } from '../../../../../shared/bots/bot-share-flag-spots'
import { reviewFlagSpots, reviewPartFiles } from '../../../../../shared/bots/bot-share-review-files'
import { reviewByline, reviewFlagPage, type BotShareReviewPage } from './bot-share-review-parts'
import { BotShareFileList } from './BotSharePartView'
import { BotShareBack } from './BotShareRows'
import {
  BotShareReviewList,
  BotShareReviewOverview,
  reviewPageTitle,
  type BotShareReviewContext
} from './BotShareReviewPages'

/** The picture the review shows: the shared image, else its mascot. */
export function reviewPictureSrc(review: BotShareReview): string | null {
  const avatar = review.bot.avatar
  if (review.avatarDataUrl) {
    return review.avatarDataUrl
  }
  return avatar && 'mascot' in avatar && isBotMascotId(avatar.mascot)
    ? BOT_MASCOT_URLS[avatar.mascot]
    : null
}

function SafetyLine({
  spots,
  onView
}: {
  spots: readonly BotShareFlagSpot[]
  onView: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [first] = spots
  if (!first) {
    return null
  }
  const secret = spots.some((spot) => spot.flag.kind === 'secret')
  const summary =
    spots.length === 1
      ? t('bots.share.review.oneFlag', '{{summary}}: {{flag}} in {{where}}', {
          summary: botShareCheckSummary(spots),
          flag: botShareFlagLabel(first.flag.kind).toLowerCase(),
          // A skill's warning names the skill; its file and line are one View away.
          where: first.part?.startsWith('skill:') ? first.part.slice('skill:'.length) : first.where
        })
      : botShareCheckSummary(spots)
  return (
    <div className="flex items-center gap-2 px-2.5 text-sm">
      <TriangleAlert
        className={cn(
          'size-3.5 shrink-0',
          secret ? 'text-destructive' : 'text-status-warning-text'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <Button type="button" size="xs" variant="ghost" onClick={onView}>
        {t('bots.share.view', 'View')}
      </Button>
    </div>
  )
}

/** What a review that leads to Create offers: tool ticks, and Create or Review again. */
type BotShareReviewChoosing = {
  toolIds: string[]
  onToolIdsChange: (ids: string[]) => void
  /** The sharer moved the link since this review: Create would write a version not shown. */
  updated: boolean
  onCreate: () => void
  onReviewAgain: () => void
}

/** `readOnly`: a copy's original, only looked at; no page offers anything to change. */
export function BotShareReviewDialog(
  props: { review: BotShareReview; onClose: () => void } & (
    | { readOnly: true }
    | ({ readOnly?: false } & BotShareReviewChoosing)
  )
): React.JSX.Element {
  const { review, onClose } = props
  const choosing = props.readOnly ? null : props
  const t = useTranslate()
  const [nav, setNav] = useState<BotShareReviewPage[]>([])
  const spots = useMemo(() => reviewFlagSpots(review), [review])
  const open = (page: BotShareReviewPage): void => setNav((current) => [...current, page])
  const ctx: BotShareReviewContext = {
    review,
    spots,
    open,
    consent: choosing ? { toolIds: choosing.toolIds, setToolIds: choosing.onToolIdsChange } : null
  }
  const page = nav.at(-1)
  const backLabel = nav.length > 1 ? reviewPageTitle(nav.at(-2)!, t) : review.bot.name
  const [first] = spots
  const viewFlag = (): void => {
    const target = spots.length === 1 && first ? reviewFlagPage(botShareFlagPage(first)) : null
    open(target ?? { kind: 'list', list: 'check' })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        // Trusting a stranger's instructions and tools: a plugin theme never restyles it.
        surface="security"
        showCloseButton={false}
        // Opened by a link, nothing is chosen yet: no control starts focused.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="grid max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-[560px]"
      >
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <BotAvatarTile
              src={reviewPictureSrc(review)}
              fallback={review.bot.name.slice(0, 1)}
              className="size-11 shrink-0 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle>{review.bot.name}</DialogTitle>
              <DialogDescription>{review.bot.purpose}</DialogDescription>
              <div className="mt-1 text-xs text-muted-foreground">{reviewByline(review)}</div>
            </div>
          </div>
          <SafetyLine spots={spots} onView={viewFlag} />
        </div>
        <div className="scrollbar-sleek -mx-1 min-h-0 overflow-y-auto px-1">
          {page ? (
            <div className="space-y-3">
              <BotShareBack label={backLabel} onBack={() => setNav((c) => c.slice(0, -1))} />
              <div>
                <div className="text-sm font-semibold">{reviewPageTitle(page, t)}</div>
                {page.kind === 'part' && page.detail ? (
                  <div className="text-xs text-muted-foreground">{page.detail}</div>
                ) : null}
              </div>
              {page.kind === 'part' ? (
                <BotShareFileList
                  files={reviewPartFiles(review, page.part)}
                  showNames={page.showNames === true}
                />
              ) : (
                <BotShareReviewList list={page.list} ctx={ctx} />
              )}
            </div>
          ) : (
            <BotShareReviewOverview ctx={ctx} />
          )}
        </div>
        <DialogFooter className="items-center">
          {choosing?.updated ? (
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {t('bots.share.review.updated', '{{who}} updated this bot. Review it again.', {
                who: review.publisher ?? t('bots.share.review.theSharer', 'The sharer')
              })}
            </span>
          ) : null}
          {!choosing ? (
            <Button type="button" onClick={onClose}>
              {t('bots.share.receive.close', 'Close')}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('bots.share.review.notNow', 'Not now')}
              </Button>
              {choosing.updated ? (
                <Button type="button" onClick={choosing.onReviewAgain}>
                  {t('bots.share.review.reviewAgain', 'Review again')}
                </Button>
              ) : (
                <Button type="button" onClick={choosing.onCreate}>
                  {t('bots.share.review.createBot', 'Create bot…')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
