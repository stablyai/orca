import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { forceLayoutReflow } from '@/lib/overlay-interaction/force-layout-reflow'
import type { FeatureTip } from '../../../../shared/feature-education/feature-tips'
import { getLocalizedFeatureTipCopy } from './feature-tip-localized-copy'
import { FeatureTipDialogFrame } from './FeatureTipDialogFrame'
import { BotsTipGroupVisual } from './BotsTipGroupVisual'
import { BotsTipItemsVisual } from './BotsTipItemsVisual'
import { BotsTipMascots } from './BotsTipMascots'
import { GroupPageCopy, ItemsPageCopy, TeammatePageCopy } from './BotsTipPageCopy'
import { BotsTipPageNav } from './BotsTipPageNav'
import { BotsTipSlackVisual } from './BotsTipSlackVisual'
import { BOTS_TIP_PAGE_COUNT, mascotPawTapping } from './bots-tip-timeline'
import { useBotsTipPlayback } from './use-bots-tip-playback'
import { useWindowStreamVisible } from '@/lib/window-activity/use-window-stream-visibility'
import './bots-tip.css'

export function BotsTeammateTipDialog({
  open,
  tip,
  onOpenChange,
  onPrimaryAction
}: {
  open: boolean
  tip: FeatureTip
  /** Closing by ×, Esc or a click outside marks the tip seen. */
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
}): JSX.Element {
  const t = useTranslate()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  // A hidden window holds the card where it is, pill included, and resumes there. No grace: the
  // frame clock stops at once on hide while the pill's CSS clock would run on.
  const windowVisible = useWindowStreamVisible(0)
  const playback = useBotsTipPlayback(open && windowVisible)
  const { page, visit, pageStarts, pageTimes, reducedMotion } = playback
  // Pages you pick are announced; the auto-advance stays quiet.
  const [announced, setAnnounced] = useState('')
  const startPage = playback.goTo
  const goTo = useCallback(
    (next: number): void => {
      startPage(next)
      const titles = [
        t('featureTips.botsTeammate.title', 'Your AI teammate'),
        t('featureTips.botsTeammate.itemsTitle', 'Its work, in one list'),
        t('featureTips.botsTeammate.groupTitle', 'Bots work together')
      ]
      setAnnounced(
        t('featureTips.botsTeammate.pageAnnounce', 'Page {{number}} of {{count}}: {{title}}', {
          number: next + 1,
          count: BOTS_TIP_PAGE_COUNT,
          title: titles[next] ?? ''
        })
      )
    },
    [startPage, t]
  )

  // The incoming copy starts 4px low with no transition, then eases up into place.
  const copyLayers = useRef<(HTMLDivElement | null)[]>([])
  useLayoutEffect(() => {
    const incoming = copyLayers.current[page]
    if (!incoming || visit === 0) {
      return
    }
    incoming.classList.add('bt-pre')
    forceLayoutReflow(incoming)
    incoming.classList.remove('bt-pre')
  }, [page, visit])

  // A page that starts again shows its first frame at once instead of animating back to it.
  const snapping = !reducedMotion && playback.t === 0 ? page : null

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight' && page < BOTS_TIP_PAGE_COUNT - 1) {
        goTo(page + 1)
      } else if (event.key === 'ArrowLeft' && page > 0) {
        goTo(page - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, page, goTo])

  const pages = [
    <TeammatePageCopy key="teammate" active={page === 0} slotStart={pageStarts[0]!} />,
    <ItemsPageCopy key="items" active={page === 1} />,
    <GroupPageCopy key="group" active={page === 2} />
  ]
  const visuals = [
    <BotsTipSlackVisual key="slack" t={pageTimes[0]!} />,
    <BotsTipItemsVisual key="items" t={pageTimes[1]!} />,
    <BotsTipGroupVisual key="group" t={pageTimes[2]!} />
  ]

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      wide
      scope="bots"
      copyClassName="justify-center"
      outside={
        <BotsTipMascots
          open={open}
          reducedMotion={reducedMotion}
          tapping={page === 0 && mascotPawTapping(pageTimes[0]!)}
        />
      }
      visual={
        // The story is drawn for the eye; the copy says it for screen readers.
        <div className="bt-visual-stack" aria-hidden inert>
          {visuals.map((visual, index) => (
            <div
              key={visual.key}
              className={cn(
                'bt-layer',
                index === page && 'bt-cur',
                index === snapping && 'bt-snap'
              )}
            >
              {visual}
            </div>
          ))}
        </div>
      }
    >
      <div className="bt-eyebrow">
        <span className="bt-new">{t('featureTips.eyebrowNew', 'New')}</span>
        {t('featureTips.botsTeammate.product', 'Orca Bots')}
      </div>
      <div className="bt-copy-stack">
        {pages.map((copy, index) => (
          <div
            key={copy.key}
            ref={(node) => {
              copyLayers.current[index] = node
            }}
            className={cn('bt-layer', index === page && 'bt-cur')}
            aria-hidden={index !== page}
          >
            {copy}
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-center gap-2">
        <BotsTipPageNav
          page={page}
          visit={visit}
          pageSeconds={playback.pageSeconds}
          pageElapsed={playback.pageElapsed}
          playing={playback.playing}
          onPage={goTo}
        />
        <span className="sr-only" aria-live="polite">
          {announced}
        </span>
        <span className="flex-1" />
        <Button ref={primaryButtonRef} onClick={onPrimaryAction}>
          <span className="bt-faces" aria-hidden>
            <img src={BOT_MASCOT_URLS.A1} alt="" />
            <img src={BOT_MASCOT_URLS.E1} alt="" />
            <img src={BOT_MASCOT_URLS.B1} alt="" />
          </span>
          {getLocalizedFeatureTipCopy(tip).ctaLabel}
        </Button>
      </div>
    </FeatureTipDialogFrame>
  )
}
