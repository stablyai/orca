import { describe, expect, it } from 'vitest'
import { draftContainsAddress, pastedAddressCandidates } from './native-chat-address-candidates'

describe('pasted address recognition', () => {
  it('keeps file-manager paths with spaces and quoted mixed-text paths intact', () => {
    expect(pastedAddressCandidates('/Users/person/Voice Notes/session 1.m4a')).toEqual([
      '/Users/person/Voice Notes/session 1.m4a'
    ])
    expect(
      pastedAddressCandidates('Compare "C:\\Voice Notes\\one.wav" with "/tmp/second note.txt"')
    ).toEqual(['C:\\Voice Notes\\one.wav', '/tmp/second note.txt'])
  })

  it('recognizes extensionless media URLs and keeps signed query strings', () => {
    expect(
      pastedAddressCandidates('Listen: https://example.com/download?id=42&signature=a%2Fb')
    ).toEqual(['https://example.com/download?id=42&signature=a%2Fb'])
  })

  it('removes prose delimiters without removing balanced URL parentheses', () => {
    expect(pastedAddressCandidates('See (https://example.com/clip(1).mp4).')).toEqual([
      'https://example.com/clip(1).mp4'
    ])
  })

  it('does not treat slash commands, relative references or network shares as local files', () => {
    expect(
      pastedAddressCandidates(
        '/help\nnotes/file.txt\n\\\\server\\share\\a.wav\n//server/share/a.wav'
      )
    ).toEqual([])
  })

  it('keeps file URLs encoded for the main-process decoder and deduplicates repeated links', () => {
    expect(
      pastedAddressCandidates('file:///tmp/note%20one.pdf\nfile:///tmp/note%20one.pdf')
    ).toEqual(['file:///tmp/note%20one.pdf'])
  })

  it('caps automatic requests per paste', () => {
    const links = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`)
    expect(pastedAddressCandidates(links.join('\n'))).toEqual(links.slice(0, 8))
  })
})

describe('draft address membership', () => {
  it('removes a stale resource when its address changes rather than matching a substring', () => {
    const source = 'https://example.com/clip.mp4'
    expect(draftContainsAddress(`${source}?revision=2`, source)).toBe(false)
    expect(draftContainsAddress(`${source}/different`, source)).toBe(false)
    expect(draftContainsAddress(`${source}x`, source)).toBe(false)
    expect(draftContainsAddress(`Watch (${source}).`, source)).toBe(true)
    expect(draftContainsAddress('', source)).toBe(false)
  })
})
