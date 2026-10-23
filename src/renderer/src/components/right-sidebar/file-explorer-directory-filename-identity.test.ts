import { describe, expect, it } from 'vitest'
import { fileExplorerEntriesToTreeNodes } from './file-explorer-directory-listing'

describe('Explorer directory filename identity', () => {
  it.each(['/', '/repo/', 'C:\\', 'C:\\repo\\', '\\\\server\\share\\'])(
    'preserves the first filename character when the root ends in a separator: %s',
    (root) => {
      const [node] = fileExplorerEntriesToTreeNodes(
        [{ name: 'abc.txt', isDirectory: false, isSymlink: false }],
        root,
        -1,
        root,
        { kind: 'local' }
      )
      expect(node.relativePath).toBe('abc.txt')
    }
  )

  it.each(['/repo', '/ssh/repo\\root'])(
    'keeps literal and nested POSIX paths distinct under %s',
    (root) => {
      const literal = fileExplorerEntriesToTreeNodes(
        [{ name: 'a\\b.txt', isDirectory: false, isSymlink: false }],
        root,
        -1,
        root,
        { kind: 'local' }
      )[0]
      const nested = fileExplorerEntriesToTreeNodes(
        [{ name: 'b.txt', isDirectory: false, isSymlink: false }],
        `${root}/a`,
        0,
        root,
        { kind: 'local' }
      )[0]
      expect(literal).toMatchObject({ path: `${root}/a\\b.txt`, relativePath: 'a\\b.txt' })
      expect(nested).toMatchObject({ path: `${root}/a/b.txt`, relativePath: 'a/b.txt' })
    }
  )

  it.each(['C:\\repo', '\\\\server\\share\\repo'])(
    'keeps Windows relative paths canonical under %s',
    (root) => {
      const [node] = fileExplorerEntriesToTreeNodes(
        [{ name: 'b.txt', isDirectory: false, isSymlink: false }],
        `${root}\\a`,
        0,
        root,
        { kind: 'local' }
      )
      expect(node).toMatchObject({ path: `${root}\\a\\b.txt`, relativePath: 'a/b.txt' })
    }
  )
})
