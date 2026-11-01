import { describe, expect, it } from 'vitest'
import { firstSyntaxExtension } from './plugin-try-action'

describe('firstSyntaxExtension', () => {
  it('takes the first extension any grammar declares', () => {
    expect(
      firstSyntaxExtension([
        { extensions: [] },
        { extensions: ['.vhd', '.vhdl'] },
        { extensions: ['.v'] }
      ])
    ).toBe('.vhd')
  })

  it('is null when grammars only match file names', () => {
    expect(firstSyntaxExtension([{ extensions: [] }])).toBeNull()
    expect(firstSyntaxExtension([])).toBeNull()
  })
})
