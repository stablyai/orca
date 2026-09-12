import { describe, expect, it } from 'vitest'

import { isImageReferenceOnlyClipboardText } from './terminal-clipboard-image-reference-text'

describe('image-reference-only clipboard text', () => {
  it('recognizes the source URL a browser "Copy Image" leaves alongside the bitmap', () => {
    expect(isImageReferenceOnlyClipboardText('https://example.com/assets/screenshot.png')).toBe(
      true
    )
    expect(isImageReferenceOnlyClipboardText('http://example.com/a/b/photo.JPG?v=2')).toBe(true)
  })

  it('recognizes percent-encoded image URLs', () => {
    expect(isImageReferenceOnlyClipboardText('https://example.com/my%20shot.png')).toBe(true)
  })

  it('recognizes local and file:// image paths, including names with spaces', () => {
    expect(isImageReferenceOnlyClipboardText('/Users/jane/Desktop/My Shot.png')).toBe(true)
    expect(isImageReferenceOnlyClipboardText('~/Pictures/cat.webp')).toBe(true)
    expect(isImageReferenceOnlyClipboardText('file:///Users/jane/Desktop/shot.png')).toBe(true)
    expect(isImageReferenceOnlyClipboardText('C:\\Users\\jane\\shot.png')).toBe(true)
    expect(isImageReferenceOnlyClipboardText('\\\\share\\team\\shot.png')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isImageReferenceOnlyClipboardText('  /tmp/shot.png\n')).toBe(true)
  })

  it('rejects ordinary text so the text fast path keeps winning', () => {
    expect(isImageReferenceOnlyClipboardText('hello')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('   ')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('line one\nline two')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('a69ce28e1d092e0c8825cd1a109ac36409962bc1')).toBe(
      false
    )
  })

  it('rejects prose that merely ends in an image filename', () => {
    expect(isImageReferenceOnlyClipboardText('see screenshot.png')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('shot.png')).toBe(false)
  })

  it('rejects non-image references', () => {
    expect(isImageReferenceOnlyClipboardText('https://example.com/report.pdf')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('https://example.com/')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('/Users/jane/notes.txt')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('data:image/png;base64,iVBORw0KGgo=')).toBe(false)
  })

  it('rejects paths whose only dot is in a directory component', () => {
    expect(isImageReferenceOnlyClipboardText('/home/jane.png/photo')).toBe(false)
  })

  it('rejects oversized text, including whitespace padding, before scanning it', () => {
    expect(isImageReferenceOnlyClipboardText(`/tmp/${'a'.repeat(4096)}.png`)).toBe(false)
    expect(isImageReferenceOnlyClipboardText(`${' '.repeat(8192)}/tmp/shot.png`)).toBe(false)
  })

  it('leaves known-residual shapes on the text path rather than over-matching', () => {
    // Relative paths and extensions hiding in a query string or fragment stay
    // text: over-matching prose would replace text the user meant to paste.
    expect(isImageReferenceOnlyClipboardText('Desktop/photo.png')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('https://example.com/view?file=shot.png')).toBe(false)
    expect(isImageReferenceOnlyClipboardText('https://example.com/view#shot.png')).toBe(false)
  })
})
