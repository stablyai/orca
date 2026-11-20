import { useState, type JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { BOTS_TIP_PAGE_COUNT } from './bots-tip-timeline'

/** Fills over the page's span on the compositor; keyed per page visit, so it restarts with the page. */
function DotFill({
  seconds,
  elapsed,
  playing
}: {
  seconds: number
  elapsed: number
  playing: boolean
}): JSX.Element {
  // Read once: a later delay would shift the running animation instead of resuming it.
  const [startAt] = useState(elapsed)
  return (
    <span
      className="bt-dot-fill"
      style={{
        animationDuration: `${seconds}s`,
        animationDelay: `${-startAt}s`,
        animationPlayState: playing ? 'running' : 'paused'
      }}
    />
  )
}

/** Arrows round the page dots; the current dot is a pill that fills as its page plays. */
export function BotsTipPageNav({
  page,
  visit,
  pageSeconds,
  pageElapsed,
  playing,
  onPage
}: {
  page: number
  visit: number
  pageSeconds: number
  pageElapsed: number
  playing: boolean
  onPage: (page: number) => void
}): JSX.Element {
  const t = useTranslate()
  return (
    <span className="bt-nav">
      <button
        type="button"
        className="bt-arrow"
        aria-label={t('featureTips.botsTeammate.previousPage', 'Previous page')}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="bt-dots">
        {Array.from({ length: BOTS_TIP_PAGE_COUNT }, (_, index) => (
          <button
            key={index}
            type="button"
            className="bt-dot"
            aria-label={t('featureTips.botsTeammate.pageNumber', 'Page {{number}}', {
              number: index + 1
            })}
            aria-current={index === page}
            onClick={() => onPage(index)}
          >
            {index === page ? (
              <DotFill key={visit} seconds={pageSeconds} elapsed={pageElapsed} playing={playing} />
            ) : null}
          </button>
        ))}
      </span>
      <button
        type="button"
        className="bt-arrow"
        aria-label={t('featureTips.botsTeammate.nextPage', 'Next page')}
        disabled={page === BOTS_TIP_PAGE_COUNT - 1}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  )
}
