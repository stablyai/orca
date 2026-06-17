import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS,
  parseFolderWorkspaceCopyIgnoreFile,
  shouldExcludeFolderWorkspaceCopyPath
} from './folder-workspace-copy-rules'

describe('folder workspace copy rules', () => {
  it('parses ignore files without comments or negation rules', () => {
    expect(
      parseFolderWorkspaceCopyIgnoreFile(
        ['# comment', 'tmp/', '!keep.log', '*.sqlite', ''].join('\n')
      )
    ).toEqual(['tmp/', '*.sqlite'])
  })

  it('excludes default generated directories at any depth', () => {
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'packages/app/node_modules/react/index.js',
        isDirectory: false,
        ignorePatterns: DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS
      })
    ).toBe(true)
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'packages/app/src/index.ts',
        isDirectory: false,
        ignorePatterns: DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS
      })
    ).toBe(false)
  })

  it('matches root relative and basename wildcard patterns', () => {
    const ignorePatterns = ['cache/', '/secrets.json', '*.sqlite']
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'nested/cache/output.txt',
        isDirectory: false,
        ignorePatterns
      })
    ).toBe(true)
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'secrets.json',
        isDirectory: false,
        ignorePatterns
      })
    ).toBe(true)
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'nested/secrets.json',
        isDirectory: false,
        ignorePatterns
      })
    ).toBe(false)
    expect(
      shouldExcludeFolderWorkspaceCopyPath({
        relativePath: 'db/dev.sqlite',
        isDirectory: false,
        ignorePatterns
      })
    ).toBe(true)
  })
})
