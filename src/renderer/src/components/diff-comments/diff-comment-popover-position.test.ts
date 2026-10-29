import { describe, expect, it } from 'vitest'

import { resolveDiffCommentPopoverTop } from './diff-comment-popover-position'

describe('resolveDiffCommentPopoverTop', () => {
  it('flips the popover above the line when it would overflow the bottom', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 380,
      lineHeight: 20,
      popoverHeight: 150,
      viewportHeight: 400
    })

    expect(top).toBe(210)
  })

  it('clamps inside the viewport when the popover fits neither below nor above', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 395,
      lineHeight: 20,
      popoverHeight: 380,
      viewportHeight: 400
    })

    expect(top).toBe(12)
  })

  it('falls back to the top margin when the popover is taller than the viewport', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 300,
      lineHeight: 20,
      popoverHeight: 420,
      viewportHeight: 400
    })

    expect(top).toBe(8)
  })
})
