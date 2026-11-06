import { expect, it } from 'vitest'
import { fileTypeOfPath } from './plugin-file-type'

it('reads the last extension of a path in lowercase', () => {
  expect(fileTypeOfPath('docs/Paper.TYP')).toBe('typ')
  expect(fileTypeOfPath('C:\\repo\\archive.tar.gz')).toBe('gz')
  expect(fileTypeOfPath('repo/.gitignore')).toBeNull()
  expect(fileTypeOfPath('repo/Makefile')).toBeNull()
  expect(fileTypeOfPath('repo/odd.ext with space')).toBeNull()
})
