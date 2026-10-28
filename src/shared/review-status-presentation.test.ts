import { describe, expect, it } from 'vitest'
import { reviewStatusPresentation } from './review-status-presentation'

describe('review status presentation', () => {
  it.each(['merged', 'draft', 'closed'] as const)(
    'keeps %s state ahead of failing checks',
    (state) => {
      const presentation = reviewStatusPresentation({ state, checksStatus: 'failure' })
      expect(presentation.tone).toBe(state)
      expect(presentation.glyph).toBe(state === 'merged' ? 'merge' : state)
    }
  )

  it('labels passing checks only when their result is known', () => {
    expect(reviewStatusPresentation({ state: 'open', checksStatus: 'success' })).toMatchObject({
      tone: 'success',
      label: 'Open pull request, checks passing'
    })
    expect(reviewStatusPresentation({ state: 'open', checksStatus: 'neutral' })).toMatchObject({
      tone: 'open',
      label: 'Open pull request'
    })
    expect(
      reviewStatusPresentation({ state: 'open', checksStatus: 'failure', showChecks: false })
    ).toMatchObject({ tone: 'open' })
  })

  it('keeps no-review and explicit unknown neutral, while retaining legacy stateless desktop problems', () => {
    expect(reviewStatusPresentation({ hasReview: false, checksStatus: 'failure' })).toMatchObject({
      glyph: 'branch',
      tone: 'neutral'
    })
    expect(reviewStatusPresentation({ state: 'unknown', checksStatus: 'failure' })).toMatchObject({
      glyph: 'branch',
      tone: 'neutral'
    })
    expect(reviewStatusPresentation({ checksStatus: 'failure' }).tone).toBe('failure')
    expect(reviewStatusPresentation({ checksStatus: 'success' }).tone).toBe('neutral')
  })
})
