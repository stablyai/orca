import { describe, expect, it } from 'vitest'
import { parseFileLinkLocation } from './file-link-location'

describe('parseFileLinkLocation', () => {
  it('preserves Windows drive colons', () => {
    expect(parseFileLinkLocation(String.raw`C:\repo\src\main.ts:12`)).toEqual({
      pathText: String.raw`C:\repo\src\main.ts`,
      line: 12,
      column: null
    })
  })
})
