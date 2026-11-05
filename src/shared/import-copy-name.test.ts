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
})
