import { describe, expect, it } from 'vitest'
import { parseFileLinkLocation } from './file-link-location'

describe('parseFileLinkLocation', () => {
  it('parses agent-style line and column suffixes', () => {
    expect(parseFileLinkLocation('src/main.ts:12:4')).toEqual({
      pathText: 'src/main.ts',
      line: 12,
      column: 4
    })
    expect(parseFileLinkLocation('src/main.ts')).toEqual({
      pathText: 'src/main.ts',
      line: null,
      column: null
    })
  })

  it('preserves Windows drive colons', () => {
    expect(parseFileLinkLocation(String.raw`C:\repo\src\main.ts:12`)).toEqual({
      pathText: String.raw`C:\repo\src\main.ts`,
      line: 12,
      column: null
    })
  })

  it('rejects empty paths and zero locations', () => {
    expect(parseFileLinkLocation('')).toBeNull()
    expect(parseFileLinkLocation('src/main.ts:0')).toBeNull()
    expect(parseFileLinkLocation('src/main.ts:12:0')).toBeNull()
  })
})
