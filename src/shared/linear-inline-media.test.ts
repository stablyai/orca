import { describe, expect, it } from 'vitest'
import { extractLinearInlineMedia } from './linear-inline-media'

describe('Linear inline media extraction', () => {
  it('extracts markdown and HTML media URLs with source metadata', () => {
    const media = extractLinearInlineMedia(
      [
        '![Screenshot](https://uploads.linear.app/workspace/file/image-id?signature=abc)',
        '<img src="https://example.com/diagram.png" />'
      ].join('\n'),
      'comment',
      'comment-1'
    )

    expect(media).toEqual([
      {
        source: 'comment',
        sourceId: 'comment-1',
        url: 'https://uploads.linear.app/workspace/file/image-id?signature=abc',
        altText: 'Screenshot',
        fileName: 'image-id',
        linearUpload: true
      },
      {
        source: 'comment',
        sourceId: 'comment-1',
        url: 'https://example.com/diagram.png',
        altText: null,
        fileName: 'diagram.png',
        linearUpload: false
      }
    ])
  })

  it('deduplicates repeated media URLs from the same markdown body', () => {
    const media = extractLinearInlineMedia(
      [
        '![](https://uploads.linear.app/workspace/file/image-id)',
        '![](https://uploads.linear.app/workspace/file/image-id)'
      ].join('\n'),
      'description'
    )

    expect(media).toHaveLength(1)
    expect(media[0]?.linearUpload).toBe(true)
  })
})
