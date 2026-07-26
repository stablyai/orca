import { describe, expect, it } from 'vitest'
import { decodeGitCQuotedPath } from './git-cquoted-path'

describe('decodeGitCQuotedPath', () => {
  it('preserves an octal UTF-8 BOM instead of treating it as Git framing', () => {
    expect(decodeGitCQuotedPath('"\\357\\273\\277name"')).toBe('\uFEFFname')
  })

  it('decodes adjacent UTF-8 octal bytes after a BOM', () => {
    expect(decodeGitCQuotedPath('"\\357\\273\\277\\343\\201\\202"')).toBe('\uFEFFあ')
  })
})
