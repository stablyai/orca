import { describe, expect, it } from 'vitest'
import { formatFinalTranscriptSegment } from './dictation-final-segments'

describe('formatFinalTranscriptSegment', () => {
  it('adds a boundary between word-like streaming final segments', () => {
    expect(formatFinalTranscriptSegment('world', 'hello')).toBe(' world')
  })

  it('adds a boundary after sentence and phrase punctuation', () => {
    expect(formatFinalTranscriptSegment('World', 'Hello.')).toBe(' World')
    expect(formatFinalTranscriptSegment('world', 'hello,')).toBe(' world')
  })

  it('does not add a boundary before punctuation', () => {
    expect(formatFinalTranscriptSegment('.', 'hello')).toBe('.')
  })

  it('does not add a boundary around CJK final segments', () => {
    expect(formatFinalTranscriptSegment('世界', '你好')).toBe('世界')
  })
})
