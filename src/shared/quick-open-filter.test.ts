import { describe, expect, it } from 'vitest'
import {
  buildExcludePathPrefixes,
  buildGitLsFilesArgsForQuickOpen,
  buildHiddenDirExcludeGlobs,
  buildRgArgsForQuickOpen,
  HIDDEN_DIR_BLOCKLIST,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from './quick-open-filter'

describe('shouldIncludeQuickOpenPath', () => {
  it('includes normal source paths', () => {
    expect(shouldIncludeQuickOpenPath('src/index.ts')).toBe(true)
    expect(shouldIncludeQuickOpenPath('.github/workflows/ci.yml')).toBe(true)
    expect(shouldIncludeQuickOpenPath('.env')).toBe(true)
  })

  it('excludes node_modules and blocklisted dirs at any depth', () => {
    expect(shouldIncludeQuickOpenPath('node_modules/a/b.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('packages/x/node_modules/a.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('.git/config')).toBe(false)
    expect(shouldIncludeQuickOpenPath('foo/.cache/bar')).toBe(false)
  })

  // Why hidden: home-dir cache/state dirs that caused the original SSH bug.
  // Test name explains why each is filtered.
  it('hides generated npm cache dir from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.npm/pkg/index.js')).toBe(false)
  })
  it('hides npm-global install state dir from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.npm-global/bin/foo')).toBe(false)
  })
  it('hides GNOME virtual FS runtime mount from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.gvfs/mount/file')).toBe(false)
  })

  it('does NOT blocklist user-authored dirs like .config, .ssh, .github', () => {
    expect(HIDDEN_DIR_BLOCKLIST.has('.config')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.ssh')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.github')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.devcontainer')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.local')).toBe(false)
  })
})

describe('buildExcludePathPrefixes', () => {
  it('returns root-relative POSIX prefixes', () => {
    expect(
      buildExcludePathPrefixes('/home/u/repo', [
        '/home/u/repo/packages/app',
        '/home/u/repo/worktrees/b'
      ])
    ).toEqual(['packages/app', 'worktrees/b'])
  })

  it('ignores malformed input', () => {
    expect(buildExcludePathPrefixes('/home/u/repo', undefined)).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', 'not-array' as unknown)).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', [null, 42, '', '/outside'])).toEqual([])
  })

  it('ignores root-equal and outside-root values', () => {
    expect(buildExcludePathPrefixes('/home/u/repo', ['/home/u/repo'])).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', ['/home/u/other'])).toEqual([])
  })

  it('handles Windows-style roots and paths', () => {
    expect(buildExcludePathPrefixes('C:\\repo', ['C:\\repo\\packages\\app'])).toEqual([
      'packages/app'
    ])
  })

  it('strips trailing slashes', () => {
    expect(buildExcludePathPrefixes('/r', ['/r/a/', '/r/b///'])).toEqual(['a', 'b'])
  })
})

describe('shouldExcludeQuickOpenRelPath', () => {
  it('matches exact and boundary paths only', () => {
    expect(shouldExcludeQuickOpenRelPath('packages/app', ['packages/app'])).toBe(true)
    expect(shouldExcludeQuickOpenRelPath('packages/app/x.ts', ['packages/app'])).toBe(true)
  })

  it('does not match sibling paths with a shared prefix', () => {
    expect(shouldExcludeQuickOpenRelPath('packages/app2/x.ts', ['packages/app'])).toBe(false)
    expect(shouldExcludeQuickOpenRelPath('packages/application', ['packages/app'])).toBe(false)
  })
})

describe('buildHiddenDirExcludeGlobs', () => {
  it('includes node_modules plus blocklist as directory-match globs', () => {
    const globs = buildHiddenDirExcludeGlobs()
    expect(globs).toContain('!**/node_modules')
    expect(globs).toContain('!**/.git')
    expect(globs).toContain('!**/.cache')
    // Directory-match form (not contents form) — contents form lets rg still
    // descend into the directory.
    expect(globs).not.toContain('!**/node_modules/**')
  })
})

describe('buildRgArgsForQuickOpen', () => {
  it('primary pass includes --files, --hidden, hidden-dir excludes, no --follow', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/root',
      excludePathPrefixes: [],
      forceSlashSeparator: false
    })
    expect(primary).toContain('--files')
    expect(primary).toContain('--hidden')
    expect(primary).toContain('!**/node_modules')
    expect(primary).not.toContain('--follow')
  })

  it('.env* pass includes --no-ignore-vcs and both root + nested globs, no --follow', () => {
    const { envPass } = buildRgArgsForQuickOpen({
      searchRoot: '/root',
      excludePathPrefixes: [],
      forceSlashSeparator: false
    })
    expect(envPass).toContain('--no-ignore-vcs')
    expect(envPass).toContain('.env*')
    expect(envPass).toContain('**/.env*')
    expect(envPass).not.toContain('--follow')
  })

  it('forceSlashSeparator emits --path-separator /', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/r',
      excludePathPrefixes: [],
      forceSlashSeparator: true
    })
    const idx = primary.indexOf('--path-separator')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(primary[idx + 1]).toBe('/')
  })

  it('excludePathPrefixes are escaped as directory-match globs', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/r',
      excludePathPrefixes: ['packages/app', 'feature[1]'],
      forceSlashSeparator: false
    })
    expect(primary).toContain('!packages/app')
    expect(primary).toContain('!packages/app/**')
    // Glob metacharacters in a literal name must be escaped.
    expect(primary).toContain('!feature\\[1\\]')
  })
})

describe('normalizeQuickOpenRgLine', () => {
  it('strips absolute root prefix', () => {
    expect(
      normalizeQuickOpenRgLine('/root/src/a.ts', { kind: 'absolute', rootPath: '/root' })
    ).toBe('src/a.ts')
  })

  it('strips Windows drive absolute root prefixes', () => {
    expect(
      normalizeQuickOpenRgLine('C:\\repo\\src\\a.ts', {
        kind: 'absolute',
        rootPath: 'C:\\repo'
      })
    ).toBe('src/a.ts')
  })

  it('preserves Windows UNC roots while stripping absolute root prefixes', () => {
    expect(
      normalizeQuickOpenRgLine('\\\\server\\share\\repo\\src\\a.ts', {
        kind: 'absolute',
        rootPath: '\\\\server\\share\\repo'
      })
    ).toBe('src/a.ts')
  })

  it('strips ./ prefix in cwd-relative mode', () => {
    expect(normalizeQuickOpenRgLine('./src/a.ts', { kind: 'cwd-relative' })).toBe('src/a.ts')
  })

  it('strips CRLF', () => {
    expect(normalizeQuickOpenRgLine('/root/a.ts\r', { kind: 'absolute', rootPath: '/root' })).toBe(
      'a.ts'
    )
  })

  it('returns null for paths outside the absolute root', () => {
    expect(
      normalizeQuickOpenRgLine('/other/a.ts', { kind: 'absolute', rootPath: '/root' })
    ).toBeNull()
  })

  it('returns null for empty or root-equal lines', () => {
    expect(normalizeQuickOpenRgLine('', { kind: 'cwd-relative' })).toBeNull()
    expect(normalizeQuickOpenRgLine('.', { kind: 'cwd-relative' })).toBeNull()
  })
})

describe('buildGitLsFilesArgsForQuickOpen', () => {
  it('primary pass is --cached --others --exclude-standard', () => {
    const { primary } = buildGitLsFilesArgsForQuickOpen()
    expect(primary).toEqual(['--cached', '--others', '--exclude-standard'])
  })

  it('env pass surfaces gitignored .env at root and nested, without --exclude-standard', () => {
    const { envPass } = buildGitLsFilesArgsForQuickOpen()
    expect(envPass).toContain('--others')
    expect(envPass).toContain('.env*')
    expect(envPass).toContain(':(glob)**/.env*')
    expect(envPass).not.toContain('--exclude-standard')
  })

  it('exclude prefixes prepend positive "." pathspec', () => {
    const { primary } = buildGitLsFilesArgsForQuickOpen(['packages/app'])
    const dashDashIdx = primary.indexOf('--')
    expect(dashDashIdx).toBeGreaterThanOrEqual(0)
    // Positive pathspec must appear before any exclude pathspec.
    expect(primary[dashDashIdx + 1]).toBe('.')
    expect(primary).toContain(':(exclude,glob)packages/app')
    expect(primary).toContain(':(exclude,glob)packages/app/**')
  })
})
