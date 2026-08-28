import { describe, expect, it } from 'vitest'
import { buildDocPreviewUrl, parseDocPreviewUrl } from './doc-preview-scheme'

const GRANT = 'a'.repeat(32)

describe('doc preview URLs', () => {
  it('round-trips a nested relative path', () => {
    const url = buildDocPreviewUrl(GRANT, 'assets/logo.png')

    expect(url).toBe(`orca-preview://${GRANT}/assets/logo.png`)
    expect(parseDocPreviewUrl(url)).toEqual({ grantId: GRANT, relativePath: 'assets/logo.png' })
  })

  it('encodes characters that would otherwise split the URL', () => {
    const url = buildDocPreviewUrl(GRANT, 'a b/c#d?e.html')

    expect(url).toBe(`orca-preview://${GRANT}/a%20b/c%23d%3Fe.html`)
    expect(parseDocPreviewUrl(url)).toEqual({ grantId: GRANT, relativePath: 'a b/c#d?e.html' })
  })

  it('normalizes backslashes into path segments so a Windows path cannot smuggle one segment', () => {
    expect(parseDocPreviewUrl(buildDocPreviewUrl(GRANT, 'assets\\logo.png'))).toEqual({
      grantId: GRANT,
      relativePath: 'assets/logo.png'
    })
  })

  it('reports an empty relative path for a root request', () => {
    expect(parseDocPreviewUrl(`orca-preview://${GRANT}/`)).toEqual({
      grantId: GRANT,
      relativePath: ''
    })
  })

  it('rejects malformed grant ids and other schemes', () => {
    expect(parseDocPreviewUrl('orca-preview://SHORT/index.html')).toBeNull()
    expect(parseDocPreviewUrl(`orca-preview://${'g'.repeat(32)}/index.html`)).toBeNull()
    expect(parseDocPreviewUrl(`https://${GRANT}/index.html`)).toBeNull()
    expect(parseDocPreviewUrl('not a url')).toBeNull()
  })

  it('rejects an undecodable percent sequence rather than passing raw bytes through', () => {
    expect(parseDocPreviewUrl(`orca-preview://${GRANT}/%E0%A4%A.html`)).toBeNull()
  })
})
