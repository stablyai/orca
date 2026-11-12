import { describe, expect, it } from 'vitest'
import { formatImageDropPasteText } from '../../../../../../shared/image-path-paste'

describe('formatImageDropPasteText', () => {
  it('refuses paths a paste frame would alter', () => {
    expect(formatImageDropPasteText('/t/a\nb.png', 'posix')).toBeNull()
    expect(formatImageDropPasteText('/t/a\u001bb.png', 'posix')).toBeNull()
    expect(formatImageDropPasteText('C:\\t\\a\u0007b.png', 'windows')).toBeNull()
  })
})
