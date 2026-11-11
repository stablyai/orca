import { describe, expect, it } from 'vitest'
import { parseFileLinkLocation } from './file-link-location'

describe('parseFileLinkLocation', () => {
  it('parses a line-range suffix using its starting line', () => {
    expect(parseFileLinkLocation('src/main.ts:12-18')).toEqual({
      pathText: 'src/main.ts',
      line: 12,
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
})
