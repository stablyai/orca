import { describe, expect, it } from 'vitest'
import { toLocalWslDropPath } from './terminal-drop-local-wsl-path'

describe('toLocalWslDropPath', () => {
  it('maps drive-letter and WSL UNC paths into the local distro', () => {
    expect(toLocalWslDropPath('C:\\Users\\me\\file.txt')).toBe('/mnt/c/Users/me/file.txt')
    expect(toLocalWslDropPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\file.txt')).toBe(
      '/home/me/file.txt'
    )
  })

  it.each([
    ['\\\\server\\share\\file.txt', '//server/share/file.txt'],
    ['//server/share/file.txt', '//server/share/file.txt']
  ])('preserves generic UNC paths without drive-letter mapping', (path, expected) => {
    expect(toLocalWslDropPath(path)).toBe(expected)
  })
})
