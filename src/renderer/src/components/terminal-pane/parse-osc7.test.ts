import { describe, it, expect } from 'vitest'
import { parseOsc7 } from './parse-osc7'

describe('parseOsc7', () => {
  it('extracts a plain POSIX path', () => {
    expect(parseOsc7('file://host/home/jin/repo')).toBe('/home/jin/repo')
  })

  it('accepts an empty host', () => {
    expect(parseOsc7('file:///home/jin')).toBe('/home/jin')
  })

  it('percent-decodes spaces and unicode', () => {
    expect(parseOsc7('file:///home/jin/my%20code')).toBe('/home/jin/my code')
  })

  it('strips the leading slash before a Windows drive letter', () => {
    expect(parseOsc7('file:///C:/Users/jin/repo')).toBe('C:/Users/jin/repo')
  })

  it('returns null for non-file URIs', () => {
    expect(parseOsc7('http://example.com/')).toBeNull()
  })

  it('returns null for unterminated/malformed input', () => {
    expect(parseOsc7('not a uri')).toBeNull()
    expect(parseOsc7('file://host')).toBeNull()
  })

  it('returns null for invalid percent-encoding', () => {
    expect(parseOsc7('file:///bad%ZZ')).toBeNull()
  })
})
