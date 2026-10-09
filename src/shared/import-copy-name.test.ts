import { describe, expect, it } from 'vitest'
import { deconflictCopyName } from './import-copy-name'

function takenFrom(names: string[]): (name: string) => Promise<boolean> {
  return async (name) => names.includes(name)
}

describe('deconflictCopyName', () => {
  it('keeps a free original name', async () => {
    expect(await deconflictCopyName('a.txt', takenFrom([]))).toBe('a.txt')
  })

  it('inserts the copy suffix before the extension', async () => {
    expect(await deconflictCopyName('a.txt', takenFrom(['a.txt']))).toBe('a copy.txt')
    expect(await deconflictCopyName('a.txt', takenFrom(['a.txt', 'a copy.txt']))).toBe(
      'a copy 2.txt'
    )
  })

  it('treats a dotfile as all stem', async () => {
    expect(await deconflictCopyName('.env', takenFrom(['.env']))).toBe('.env copy')
  })

  it('checks existence before reserved names, and both count as taken', async () => {
    const calls: string[] = []
    const reserved = new Set(['a copy.txt'])
    const existing = new Set(['a.txt'])
    const name = await deconflictCopyName('a.txt', async (n) => {
      calls.push(`exists:${n}`)
      if (existing.has(n)) {
        return true
      }
      calls.push(`reserved:${n}`)
      return reserved.has(n)
    })
    expect(name).toBe('a copy 2.txt')
    expect(calls).toEqual([
      'exists:a.txt',
      'exists:a copy.txt',
      'reserved:a copy.txt',
      'exists:a copy 2.txt',
      'reserved:a copy 2.txt'
    ])
  })
})
