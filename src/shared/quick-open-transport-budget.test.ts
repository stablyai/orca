import { describe, expect, it } from 'vitest'
import { limitQuickOpenFilesBySerializedBytes } from './quick-open-transport-budget'

describe('Quick Open transport byte budget', () => {
  it('returns the largest prefix that fits as a JSON array', () => {
    const files = ['src/a.ts', 'data/ignored\nfile.bin', 'src/b.ts']
    const budget = Buffer.byteLength(JSON.stringify(files.slice(0, 2)), 'utf8')
    expect(limitQuickOpenFilesBySerializedBytes(files, budget)).toEqual(files.slice(0, 2))
  })
})
