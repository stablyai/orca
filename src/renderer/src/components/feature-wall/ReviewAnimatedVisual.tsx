import type { JSX } from 'react'
import type { ReviewStepId } from '../../../../shared/review-steps'
import { PANEL_HEIGHT, PANEL_WIDTH } from './review-animated-visual-shared'
import { ReviewNotesAnimatedVisual } from './ReviewNotesAnimatedVisual'
import { ReviewPRViewAnimatedVisual } from './ReviewPRViewAnimatedVisual'
import { ReviewShipAnimatedVisual } from './ReviewShipAnimatedVisual'

// Why: thin dispatcher — picks the sub-step page. Each page renders its own
// scoped <style> tag. The `key` prop forces unmount/remount so each page's
// effect cleanup fires cleanly when the user flips between Notes, PR view,
// and Ship.
export function ReviewAnimatedVisual(props: {
  reducedMotion: boolean
  activeStepId: ReviewStepId
}): JSX.Element {
  const { reducedMotion, activeStepId } = props
  return (
    <div className="relative overflow-visible" style={{ width: PANEL_WIDTH, height: PANEL_HEIGHT }}>
      {activeStepId === 'notes' ? (
        <ReviewNotesAnimatedVisual key="notes" reducedMotion={reducedMotion} />
      ) : activeStepId === 'pr-view' ? (
        <ReviewPRViewAnimatedVisual key="pr-view" reducedMotion={reducedMotion} />
      ) : (
        <ReviewShipAnimatedVisual key="ship" reducedMotion={reducedMotion} />
      )}
    </div>
  )
}
