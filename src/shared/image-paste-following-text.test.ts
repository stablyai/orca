import { describe, expect, it } from 'vitest'
import {
  IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR,
  imagePasteWritesFollowedByText
} from './image-paste-following-text'

const IMAGE_A = '\x1b[200~/tmp/orca-paste-a.png\x1b[201~'
const IMAGE_B = '\x1b[200~/tmp/orca-paste-b.png\x1b[201~'

describe('imagePasteWritesFollowedByText', () => {
  it('separates an attachment path from following prompt text by a single space', () => {
    expect(imagePasteWritesFollowedByText([IMAGE_A], true)).toEqual([`${IMAGE_A} `])
    expect(IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR).toBe(' ')
  })

  it('keeps an attachment-only send as the framed path with no trailing separator', () => {
    expect(imagePasteWritesFollowedByText([IMAGE_A], false)).toEqual([IMAGE_A])
  })

  it('returns no writes when there are no image pastes', () => {
    expect(imagePasteWritesFollowedByText([], true)).toEqual([])
  })

  it('keeps back-to-back image frames bare and separates only the final frame from prompt text', () => {
    expect(imagePasteWritesFollowedByText([IMAGE_A, IMAGE_B], true)).toEqual([
      IMAGE_A,
      `${IMAGE_B} `
    ])
    expect(imagePasteWritesFollowedByText([IMAGE_A, IMAGE_B], false)).toEqual([IMAGE_A, IMAGE_B])
  })
})
