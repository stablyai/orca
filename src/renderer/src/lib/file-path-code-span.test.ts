import { describe, expect, it } from 'vitest'
import { isFilePathCodeSpan } from './file-path-code-span'

describe('isFilePathCodeSpan', () => {
  it.each([
    'docs/mobile-chat-file-path-links.md',
    'src/renderer/src/lib/terminal-links.ts',
    './src/app/Main.tsx',
    '../shared/types.ts',
    '/Users/me/repo/src/index.ts',
    '~/Documents/notes.md',
    'src/foo/bar.ts:12:7',
    'src/foo/bar.ts:12',
    'C:\\repo\\config.json',
    'src\\app\\Main.tsx',
    'docs/My File.md',
    'C:\\repo\\My File.md',
    '@scope/pkg/dist/index.js',
    'mobile/app/h/[hostId]/session/[worktreeId].tsx',
    'package.json',
    'README.md',
    'tsconfig.json',
    '.env',
    'Dockerfile',
    'src/Dockerfile',
    'Makefile'
  ])('accepts %s', (value) => {
    expect(isFilePathCodeSpan(value)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'just prose',
    'src/foo/bar.ts and more',
    '1.2.3',
    '20.11.0',
    'https://example.com/a.ts',
    'http://example.com',
    'mailto:me@example.com',
    'git@github.com:org/repo.git',
    'me@example.com',
    'someFunction',
    'npm run build',
    'src/foo/bar.ts:0',
    'src/'
  ])('rejects %s', (value) => {
    expect(isFilePathCodeSpan(value)).toBe(false)
  })

  it('rejects a bare name whose extension is not a known file type', () => {
    // Guards prose nouns that survive the dot check, e.g. a product name.
    expect(isFilePathCodeSpan('Some.Thing')).toBe(false)
  })

  it('accepts an unknown extension when a separator anchors it', () => {
    expect(isFilePathCodeSpan('build/out.customext')).toBe(true)
  })

  it('rejects a span long enough to be a code sample rather than a path', () => {
    expect(isFilePathCodeSpan(`src/${'a'.repeat(600)}.ts`)).toBe(false)
  })
})
