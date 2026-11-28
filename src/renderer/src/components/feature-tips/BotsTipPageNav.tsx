import type { JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { BOTS_TIP_PAGE_COUNT } from './bots-tip-timeline'

/** Arrows round the page dots; the current dot is a pill that fills as its page plays. */
export function BotsTipPageNav({
  page,
  progress,
  onPage
}: {
  page: number
  progress: number
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
              <span className="bt-dot-fill" style={{ transform: `scaleX(${progress})` }} />
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
