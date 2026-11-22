import { describe, expect, it } from 'vitest'
import {
  nativeChatMarkdownImageClassName,
  nativeChatMarkdownImageFrame,
  normalizeNativeChatMarkdownImageSize
} from './native-chat-markdown-image-size'

const OUTLINE = 'rounded-md object-contain outline outline-1 outline-border/70'

describe('native chat markdown image size', () => {
  it('treats an absent or unknown value as column width', () => {
    expect(normalizeNativeChatMarkdownImageSize(undefined)).toBe('column')
    expect(normalizeNativeChatMarkdownImageSize('large')).toBe('column')
    expect(nativeChatMarkdownImageClassName(undefined)).toBe(`h-auto w-full ${OUTLINE}`)
  })

  it('keeps the picture whole at each desktop preset', () => {
    expect(nativeChatMarkdownImageClassName('column')).toBe(`h-auto w-full ${OUTLINE}`)
    expect(nativeChatMarkdownImageClassName('medium')).toBe(`max-h-96 max-w-full ${OUTLINE}`)
    expect(nativeChatMarkdownImageClassName('compact')).toBe(`max-h-40 max-w-60 ${OUTLINE}`)
    for (const size of ['compact', 'medium', 'column'] as const) {
      expect(nativeChatMarkdownImageClassName(size)).toContain('object-contain')
    }
  })

  it('fits a phone picture inside the preset instead of cropping it', () => {
    expect(nativeChatMarkdownImageFrame('column', 3 / 2)).toEqual({
      width: '100%',
      aspectRatio: 3 / 2
    })
    expect(nativeChatMarkdownImageFrame('compact', 3 / 2)).toEqual({
      width: 200,
      height: 200 / 1.5,
      maxWidth: '100%',
      alignSelf: 'flex-start'
    })
    expect(nativeChatMarkdownImageFrame('medium', 3 / 2)).toEqual({
      width: 280,
      height: 280 / 1.5,
      maxWidth: '100%',
      alignSelf: 'flex-start'
    })
    expect(nativeChatMarkdownImageFrame('compact', 0.5)).toEqual({
      width: 75,
      height: 150,
      maxWidth: '100%',
      alignSelf: 'flex-start'
    })
    expect(nativeChatMarkdownImageFrame('column', null).aspectRatio).toBe(3 / 2)
  })
})
