import { describe, expect, it } from 'vitest'
import { createDictationDemoTimeline } from './voice-dictation-feature-tip-demo'

describe('createDictationDemoTimeline', () => {
  it('rests on the first phrase in the composer and the second in the listening pill', () => {
    const timeline = createDictationDemoTimeline(
      'The checkout button overlaps the footer on small screens.',
      'Can you add a test?',
      'en'
    )
    expect(timeline.frameAt(timeline.endAt)).toMatchObject({
      keys: 'hidden',
      listening: true,
      pill: true,
      draft: 'The checkout button overlaps the footer on small screens.',
      heard: 'Can you add a test?'
    })
  })
})
