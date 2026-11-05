import { describe, expect, it } from 'vitest'
import { imageCommentPosition, imageCommentsText } from './image-comment-pins'

describe('image comment positions', () => {
  it('maps a fitted or panned/zoomed image to the same percentages, excluding canvas margins', () => {
    expect(
      imageCommentPosition({ x: 250, y: 350 }, { x: 100, y: 50 }, 0.5, { width: 1200, height: 800 })
    ).toEqual({ x: 25, y: 75 })
    expect(
      imageCommentPosition({ x: 420, y: 840 }, { x: -180, y: -360 }, 2, {
        width: 1200,
        height: 800
      })
    ).toEqual({ x: 25, y: 75 })
    expect(
      imageCommentPosition({ x: 10, y: 10 }, { x: 100, y: 50 }, 0.5, { width: 1200, height: 800 })
    ).toBeNull()
    expect(
      imageCommentPosition(
        { x: -10, y: 1000 },
        { x: 100, y: 50 },
        0.5,
        { width: 1200, height: 800 },
        true
      )
    ).toEqual({ x: 0, y: 100 })
  })

  it('renumbers surviving pins and exports the comment beside its original-image coordinates', () => {
    const text = imageCommentsText('Mockup', { width: 1200, height: 800 }, [
      { id: 'second-original-pin', x: 25.125, y: 75.5, comment: '  Align this button  ' },
      { id: 'third-original-pin', x: 90, y: 10, comment: 'Use a shorter title' }
    ])
    expect(text).toContain('1. [x=25.13%, y=75.50%] Align this button')
    expect(text).toContain('2. [x=90.00%, y=10.00%] Use a shorter title')
  })
})
