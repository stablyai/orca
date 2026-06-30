import { describe, expect, it } from 'vitest'
import {
  buildQuickOpenBasenameGlob,
  resolveUniqueQuickOpenBasenameFromPaths
} from './quick-open-unique-basename'

describe('quick-open unique basename resolution', () => {
  it('returns the only matching basename', () => {
    expect(
      resolveUniqueQuickOpenBasenameFromPaths(
        ['src/terminal-link-handlers.ts', 'README.md'],
        'terminal-link-handlers.ts'
      )
    ).toBe('src/terminal-link-handlers.ts')
  })

  it('treats distinct same-basename paths as ambiguous while ignoring duplicate emissions', () => {
    expect(
      resolveUniqueQuickOpenBasenameFromPaths(
        ['src/index.ts', 'src/index.ts', 'test/index.ts'],
        'index.ts'
      )
    ).toBeNull()
  })

  it('applies Quick Open blocklists and nested-worktree exclusions', () => {
    expect(
      resolveUniqueQuickOpenBasenameFromPaths(
        ['node_modules/pkg/Foo.ts', 'packages/app/Foo.ts', 'src/Foo.ts'],
        'Foo.ts',
        ['packages/app']
      )
    ).toBe('src/Foo.ts')
  })

  it('rejects parent-relative and absolute listed paths', () => {
    expect(
      resolveUniqueQuickOpenBasenameFromPaths(
        ['../outside/Foo.ts', '/outside/Foo.ts', 'src/Foo.ts'],
        'Foo.ts'
      )
    ).toBe('src/Foo.ts')
  })

  it('escapes glob metacharacters in basename scans', () => {
    expect(buildQuickOpenBasenameGlob('feature[1].ts')).toBe('**/feature\\[1\\].ts')
    expect(buildQuickOpenBasenameGlob('dir/Foo.ts')).toBeNull()
  })
})
