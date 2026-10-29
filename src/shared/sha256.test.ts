import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256 } from './sha256'

describe('shared sha256', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1024, 65_536])(
    'matches Node crypto for a %i-byte offset view',
    (length) => {
      const backing = Uint8Array.from({ length: length + 7 }, (_, index) => index % 251)
      const bytes = backing.subarray(7)
      expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex')
      )
    }
  )
})
