import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, opendirMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  get opendir() {
    return opendirMock()
  }
}))

import { nameDarwinTerminals } from './darwin-terminal-names'

const row = '123 1 123 123 S+ 128/124 Fri Oct 9 12:34:56 2026 /bin/zsh\n'

afterEach(() => {
  vi.resetAllMocks()
})

describe('Darwin device filesystem access', () => {
  it('does not access the Darwin directory API during import or no-terminal captures', async () => {
    expect(opendirMock).not.toHaveBeenCalled()
    expect(await nameDarwinTerminals(row.replace('128/124', '??'))).toBe(
      row.replace('128/124', '??')
    )
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('reads exact bigint device metadata without following links', async () => {
    opendirMock.mockReturnValue(async () => [{ name: 'terminal' }])
    lstatMock.mockResolvedValue({ rdev: 0xffffffff8000007cn, isCharacterDevice: () => true })

    expect(await nameDarwinTerminals(row)).toBe(row.replace('128/124', 'terminal'))
    expect(lstatMock.mock.calls).toEqual([[join('/dev', 'terminal'), { bigint: true }]])
  })
})
