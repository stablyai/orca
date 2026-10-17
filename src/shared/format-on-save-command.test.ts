import { describe, expect, it } from 'vitest'
import {
  FormatOnSaveCommandError,
  SUGGESTED_FORMAT_ON_SAVE_INCLUDE,
  expandFormatOnSaveCommand,
  formatOnSaveIncludeToInput,
  parseFormatOnSaveIncludeInput,
  isFormatOnSaveConfigured,
  matchesFormatOnSaveInclude,
  normalizeRepoFormatOnSaveSettings
} from './format-on-save-command'
import { quoteForShell } from './format-on-save-command-expansion'

describe('format-on-save settings normalization', () => {
  it('treats an enabled config with a blank command as off', () => {
    expect(normalizeRepoFormatOnSaveSettings({ enabled: true, command: '   ' })).toEqual({
      enabled: false,
      command: '',
      include: []
    })
  })

  it('drops non-string and blank include entries from persisted state', () => {
    const settings = normalizeRepoFormatOnSaveSettings({
      enabled: true,
      command: 'prettier --write ${file}',
      include: ['**/*.ts', '', '   ', 7, null, '**/*.md']
    })

    expect(settings.include).toEqual(['**/*.ts', '**/*.md'])
    expect(settings.enabled).toBe(true)
  })

  it('reads a missing config as disabled defaults', () => {
    expect(normalizeRepoFormatOnSaveSettings(undefined)).toEqual({
      enabled: false,
      command: '',
      include: []
    })
    expect(isFormatOnSaveConfigured(undefined)).toBe(false)
  })
})

describe('format-on-save include matching', () => {
  it('matches every saved file when no globs are configured', () => {
    expect(matchesFormatOnSaveInclude('src/a.ts', [])).toBe(true)
  })

  it('matches nested and root files for a leading double star', () => {
    expect(matchesFormatOnSaveInclude('src/deep/nested/a.ts', ['**/*.ts'])).toBe(true)
    expect(matchesFormatOnSaveInclude('a.ts', ['**/*.ts'])).toBe(true)
  })

  it('expands brace alternatives', () => {
    const include = ['**/*.{ts,tsx,json}']
    expect(matchesFormatOnSaveInclude('src/a.tsx', include)).toBe(true)
    expect(matchesFormatOnSaveInclude('src/a.json', include)).toBe(true)
    expect(matchesFormatOnSaveInclude('src/a.css', include)).toBe(false)
  })

  it('keeps a single star from crossing directory boundaries', () => {
    expect(matchesFormatOnSaveInclude('src/deep/a.ts', ['src/*.ts'])).toBe(false)
    expect(matchesFormatOnSaveInclude('src/a.ts', ['src/*.ts'])).toBe(true)
  })

  it('matches a slashless pattern against the basename in any directory', () => {
    expect(matchesFormatOnSaveInclude('deep/nested/a.ts', ['*.ts'])).toBe(true)
  })

  it('normalizes windows separators before matching', () => {
    expect(matchesFormatOnSaveInclude('src\\deep\\a.ts', ['src/**/*.ts'])).toBe(true)
  })

  it('does not let glob metacharacters in a path widen the match', () => {
    expect(matchesFormatOnSaveInclude('src/a.ts', ['src/a.t?'])).toBe(true)
    expect(matchesFormatOnSaveInclude('src/reportx2026.ts', ['src/report.2026.ts'])).toBe(false)
  })
})

describe('format-on-save command expansion', () => {
  it('substitutes absolute and relative tokens', () => {
    expect(
      expandFormatOnSaveCommand({
        command: 'prettier --write ${file} # ${relativeFile}',
        absolutePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        platform: 'darwin'
      })
    ).toBe("prettier --write '/repo/src/a.ts' # ${relativeFile}")
  })

  it('leaves a token-free command untouched', () => {
    expect(
      expandFormatOnSaveCommand({
        command: 'pnpm format',
        absolutePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        platform: 'linux'
      })
    ).toBe('pnpm format')
  })

  it('quotes paths that would otherwise break out of the argument', () => {
    expect(
      expandFormatOnSaveCommand({
        command: 'prettier --write ${file}',
        absolutePath: "/repo/a b/it's; rm -rf ~.ts",
        relativePath: "a b/it's; rm -rf ~.ts",
        platform: 'darwin'
      })
    ).toBe(`prettier --write '/repo/a b/it'\\''s; rm -rf ~.ts'`)
  })

  it('does not rescan a substituted path, so a token in a filename stays quoted', () => {
    // Why: `${file}` is a legal POSIX filename. Substituting sequentially spliced
    // the absolute path inside the already-quoted relative path and broke quoting.
    const relativePath = 'src/a${file}b.ts'
    expect(
      expandFormatOnSaveCommand({
        command: 'prettier --write ${relativeFile}',
        absolutePath: `/repo/${relativePath}`,
        relativePath,
        platform: 'darwin'
      })
    ).toBe("prettier --write 'src/a${file}b.ts'")
  })

  it('substitutes both tokens independently in one pass', () => {
    expect(
      expandFormatOnSaveCommand({
        command: '${file} ${relativeFile} ${file}',
        absolutePath: '/repo/a.ts',
        relativePath: 'a.ts',
        platform: 'darwin'
      })
    ).toBe("'/repo/a.ts' 'a.ts' '/repo/a.ts'")
  })

  it('treats a dollar-brace sequence in the replacement as literal text', () => {
    // Why: String.replace expands `$&`-style patterns in a string replacement;
    // the callback form must not.
    expect(
      expandFormatOnSaveCommand({
        command: 'fmt ${file}',
        absolutePath: '/repo/$&$`.ts',
        relativePath: '$&$`.ts',
        platform: 'darwin'
      })
    ).toBe("fmt '/repo/$&$`.ts'")
  })

  it('wraps windows paths in double quotes', () => {
    expect(quoteForShell('C:\\repo\\a b.ts', 'win32')).toBe('"C:\\repo\\a b.ts"')
  })
})

describe('format-on-save command expansion quoting context', () => {
  const expand = (command: string, absolutePath: string, platform: NodeJS.Platform = 'linux') =>
    expandFormatOnSaveCommand({ command, absolutePath, relativePath: absolutePath, platform })

  it('escapes for double quotes instead of adding single quotes inside them', () => {
    expect(expand('fmt "${file}"', '/r/$(touch x)`id`"\\.ts')).toBe(
      'fmt "/r/\\$(touch x)\\`id\\`\\"\\\\.ts"'
    )
  })

  it('closes and reopens the quote when the token sits inside single quotes', () => {
    expect(expand("fmt 'a${file}b'", "/r/it's.ts")).toBe("fmt 'a''/r/it'\\''s.ts''b'")
  })

  it('quotes a token inside command substitution independently of the outer quotes', () => {
    expect(expand('echo "$(cat ${file})"', '/r/a b.ts')).toBe('echo "$(cat \'/r/a b.ts\')"')
  })

  it('leaves an escaped dollar unexpanded', () => {
    expect(expand('echo \\${file}', '/r/a.ts')).toBe('echo \\${file}')
  })

  it('does not expand tokens in a shell comment, where a newline in the name would end the comment', () => {
    expect(expand('fmt # ${file}', '/r/a\nrm -rf x.ts')).toBe('fmt # ${file}')
    expect(expand('fmt a#b ${file}', '/r/a.ts')).toBe("fmt a#b '/r/a.ts'")
  })

  it('refuses tokens where quoting is not modelled', () => {
    expect(() => expand('echo `cat ${file}`', '/r/a.ts')).toThrow(FormatOnSaveCommandError)
    expect(() => expand("echo $'${file}'", '/r/a.ts')).toThrow(FormatOnSaveCommandError)
    expect(() => expand('cat <<EOF\n${file}\nEOF', '/r/a.ts')).toThrow(FormatOnSaveCommandError)
  })

  it('keeps a relative path that starts with a dash from being read as an option', () => {
    expect(
      expandFormatOnSaveCommand({
        command: 'fmt ${relativeFile}',
        absolutePath: '/r/--config=x.js',
        relativePath: '--config=x.js',
        platform: 'linux'
      })
    ).toBe("fmt './--config=x.js'")
  })

  it('refuses a windows path cmd.exe would expand or misparse', () => {
    expect(() => expand('fmt ${file}', 'C:\\r\\%USERNAME%.ts', 'win32')).toThrow(
      FormatOnSaveCommandError
    )
    expect(() => expand('fmt ${file}', 'C:\\r\\a"b.ts', 'win32')).toThrow(FormatOnSaveCommandError)
  })

  it('does not add a second pair of quotes to a windows token already in quotes', () => {
    expect(expand('fmt "${file}"', 'C:\\r\\a b.ts', 'win32')).toBe('fmt "C:\\r\\a b.ts"')
    expect(expand('fmt ${file}', 'C:\\r\\a b&c.ts', 'win32')).toBe('fmt "C:\\r\\a b&c.ts"')
  })
})

describe('format-on-save include input', () => {
  it('splits on commas and newlines and drops empty entries', () => {
    expect(parseFormatOnSaveIncludeInput('**/*.ts, **/*.md,\n\n  **/*.css  ,')).toEqual([
      '**/*.ts',
      '**/*.md',
      '**/*.css'
    ])
  })

  it('round-trips through the settings input', () => {
    const include = ['**/*.ts', '**/*.md']
    expect(parseFormatOnSaveIncludeInput(formatOnSaveIncludeToInput(include))).toEqual(include)
  })

  it('keeps commas inside brace groups, including the suggested pattern', () => {
    expect(parseFormatOnSaveIncludeInput(SUGGESTED_FORMAT_ON_SAVE_INCLUDE)).toEqual([
      SUGGESTED_FORMAT_ON_SAVE_INCLUDE
    ])
    expect(parseFormatOnSaveIncludeInput('src/**/*.{ts,tsx}, *.md\n**/*.{css,scss}')).toEqual([
      'src/**/*.{ts,tsx}',
      '*.md',
      '**/*.{css,scss}'
    ])
  })

  it('round-trips a brace pattern through the settings input', () => {
    const include = ['**/*.{ts,tsx}', '**/*.md']
    expect(parseFormatOnSaveIncludeInput(formatOnSaveIncludeToInput(include))).toEqual(include)
  })

  it('does not let an unclosed brace swallow later lines', () => {
    expect(parseFormatOnSaveIncludeInput('*.{ts\n*.md, *.css')).toEqual(['*.{ts', '*.md', '*.css'])
  })

  it('reads an empty field as no restriction', () => {
    expect(parseFormatOnSaveIncludeInput('   ')).toEqual([])
  })
})
