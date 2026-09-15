import { describe, expect, it } from 'vitest'
import {
  isSafePluginCapabilityPath,
  PLUGIN_CAPABILITY_PATH_LIMIT,
  PLUGIN_CAPABILITY_PATH_MAX_LENGTH,
  pluginCapabilityPathError,
  pluginCapabilityPathsSchema,
  pluginCapabilityPathSchema
} from './plugin-capability-scope'

// Named code points rather than pasted raw bytes: a raw control byte survives
// neither a diff viewer nor a copy-paste, and an invisible fixture is the same
// class of defect this table exists to refuse.
const RLO = String.fromCharCode(0x202e)
const NUL = String.fromCharCode(0)

// Labelled rather than interpolated: `%s` renders the empty string as nothing, which
// would leave one row of this table invisible in the runner output. The label is also
// what distinguishes rows whose values look identical on screen.
//
// Deliberately NOT refused here, and recorded so the boundary reads as a decision:
// `con/**` (a Windows reserved device name) and `docs./**` (a trailing-dot segment)
// are both accepted. A reserved name and a trailing dot are properties of a resolved
// path at match time, not of a declared pattern at manifest-validation time — they
// belong to TEST-01 in Phase 7 and to the matcher dialect in Phase 2.
const REJECTED: [string, string][] = [
  ['the empty string', ''],
  ['/etc/passwd', '/etc/passwd'],
  ['C:\\x', 'C:\\x'],
  ['\\\\srv\\share', '\\\\srv\\share'],
  ['../x', '../x'],
  ['a/../b', 'a/../b'],
  ['a\\..\\b', 'a\\..\\b'],
  ['!foo', '!foo'],
  ['a?b', 'a?b'],
  ['a{b,c}', 'a{b,c}'],
  ['a[bc]', 'a[bc]'],
  // G-1: extglob smuggles negation and alternation past a metacharacter denylist.
  ['src/!(secret)/**', 'src/!(secret)/**'],
  ['docs/!(secret)/**', 'docs/!(secret)/**'],
  ['!(secret)/**', '!(secret)/**'],
  ['@(a|b)/**', '@(a|b)/**'],
  ['@(src|.ssh)/**', '@(src|.ssh)/**'],
  ['+(a|b)/**', '+(a|b)/**'],
  ['*(x)/**', '*(x)/**'],
  ['a|b/**', 'a|b/**'],
  // G-1: the backslash means a separator on one OS and an escape on another, so one
  // declared pattern would mean two things across the three platforms Orca ships.
  ['src/** with a trailing dangling escape', 'src/**\\'],
  ['docs\\**', 'docs\\**'],
  ['a/\\.\\./b', 'a/\\.\\./b'],
  ['a/.\\./b', 'a/.\\./b'],
  ['x/\\../b', 'x/\\../b'],
  // G-2: a control, bidi or whitespace character makes the rendered pattern differ
  // from the pattern the host stores and later enforces.
  ['a newline smuggling a second grant', 'src/**\nAlso grants: .ssh/**'],
  ['a newline mid-pattern', 'a\nb/**'],
  ['a trailing carriage return', 'src/**\r'],
  ['a carriage return mid-pattern', 'a\rb/**'],
  ['a trailing tab', 'src/**\t'],
  ['U+202E in leading position', `${RLO}dm.*/cod`],
  ['U+202E in mid-string position', `docs/${RLO}txt.terces/**`],
  ['a trailing NUL', `src/${NUL}`],
  ['a NUL mid-pattern', `a${NUL}b/**`],
  ['a trailing space', 'src/ '],
  ['a space before the separator', 'docs /**'],
  ['a leading space', ' evil/**'],
  ['whitespace only', '   '],
  // WR-01: one grant spelled several ways would consume several budget slots and
  // render as several identical-looking consent rows.
  ['./docs/**', './docs/**'],
  ['docs//**', 'docs//**'],
  ['docs/./**', 'docs/./**'],
  // WR-01, Unicode half: refusing non-ASCII removes the normalisation question
  // rather than answering it, so neither spelling of an accented name is accepted.
  ['cafe/** precomposed (U+00E9)', 'caf\u00e9/**'],
  ['cafe/** decomposed (e + U+0301)', 'cafe\u0301/**'],
  // Home-relative: `~` is a shell expansion, not a worktree-relative pattern.
  ['~/**', '~/**'],
  ['a**b', 'a**b'],
  ['**x', '**x'],
  ['x**', 'x**'],
  ['***', '***']
]

// `**` and `*` must stay accepted — they are the whole-worktree and single-segment
// forms the feature is specified in terms of. A Phase 2 matcher that needs brace or
// bracket syntax would invalidate a refusal fixed here (D-05); its research has to
// close that before it picks a matcher.
// `foo..bar` is the negative control for the ".." rule: it proves the check compares
// whole segments rather than searching for a substring.
// This table is the no-regression half of the allowlist tightening: an entry leaving
// it means a manifest that used to validate no longer does, which would drop an
// already-approved plugin to pending re-approval.
// `src/sub-dir_1/*.md` proves the hyphen, the underscore and a digit stay accepted,
// so the allowlist did not narrow past what a real manifest needs.
const ACCEPTED = [
  '**',
  '*',
  '*.md',
  '.planning/**',
  'src/**',
  'docs/**',
  'README.md',
  'foo..bar',
  'src/sub-dir_1/*.md'
]

describe('plugin capability path refusals', () => {
  it.each(REJECTED)('rejects %s', (_label, value) => {
    expect(isSafePluginCapabilityPath(value)).toBe(false)
  })

  it.each(ACCEPTED)('accepts %s', (value) => {
    expect(isSafePluginCapabilityPath(value)).toBe(true)
  })
})

describe('plugin capability path messages', () => {
  it('names the empty pattern rather than reporting it safe', () => {
    // Why on the predicate directly: the emptiness rule lives in the predicate, not
    // only in the schema, so the exported wrapper stays honest when called alone.
    expect(pluginCapabilityPathError('')).toBe('must not be empty')
    expect(isSafePluginCapabilityPath('')).toBe(false)
  })

  it.each(['C:\\x', '\\\\srv\\share'])('names %s as an absolute path', (value) => {
    expect(pluginCapabilityPathError(value)).toBe('must not be an absolute path')
  })

  it('names a leading separator and says what paths are relative to', () => {
    expect(pluginCapabilityPathError('/etc/passwd')).toBe(
      'must not start with a path separator (paths are relative to the worktree root)'
    )
  })

  it.each(['../x', 'a/../b', 'a\\..\\b'])('names the ".." segment in %s', (value) => {
    expect(pluginCapabilityPathError(value)).toBe('must not contain a ".." segment')
  })

  // `src/**\` belongs to this family rather than to the catch-all: PATH_SEPARATOR_RE
  // treats the backslash as a separator, so it splits to a trailing empty segment and
  // this rule fires before the character-set rule is ever reached.
  it.each(['./docs/**', 'docs//**', 'docs/./**', 'src/**\\'])(
    'names the empty or "." segment in %s',
    (value) => {
      expect(pluginCapabilityPathError(value)).toBe('must not contain an empty or "." path segment')
    }
  )

  it.each(['!foo', '!(secret)/**', 'src/!(secret)/**'])(
    'names a negation pattern in %s, wherever the exclamation mark sits',
    (value) => {
      expect(pluginCapabilityPathError(value)).toBe('must not use a negation pattern')
    }
  )

  it.each(['a|b/**', '@(a|b)/**', '+(a|b)/**'])('names an alternation pattern in %s', (value) => {
    expect(pluginCapabilityPathError(value)).toBe('must not use an alternation pattern')
  })

  it.each(['a?b', 'a{b,c}', 'a[bc]'])('names the unsupported metacharacter in %s', (value) => {
    expect(pluginCapabilityPathError(value)).toBe('must not use "?", "{}" or "[]"')
  })

  it.each(['a**b', '**x', 'x**', '***'])('names malformed double-star syntax in %s', (value) => {
    expect(pluginCapabilityPathError(value)).toBe('must use "**" only as a complete path segment')
  })

  // One representative per hostile class the catch-all owns. `docs\**` is the
  // backslash representative rather than `src/**\`, because it splits with no empty
  // segment and therefore actually reaches this rule.
  it.each([
    ['*(x)/**', '*(x)/**'],
    ['docs\\**', 'docs\\**'],
    ['a trailing tab', 'src/**\t'],
    ['U+202E in leading position', `${RLO}dm.*/cod`],
    ['a trailing NUL', `src/${NUL}`],
    ['a trailing space', 'src/ '],
    ['~/**', '~/**'],
    ['cafe/** decomposed (e + U+0301)', 'cafe\u0301/**']
  ])('names the accepted character set for %s', (_label, value) => {
    expect(pluginCapabilityPathError(value)).toBe(
      'must use only letters, digits, ".", "_", "-", "/" and "*"'
    )
  })
})

describe('plugin capability double-star dialect', () => {
  it.each(['a**b', '**x', 'x**', '***'])('refuses malformed form %s at schema load', (value) => {
    expect(pluginCapabilityPathSchema.safeParse(value).success).toBe(false)
  })

  it.each(['*', '**', '*.md', 'docs/*', 'docs/**'])('keeps supported form %s loadable', (value) => {
    expect(pluginCapabilityPathSchema.safeParse(value).success).toBe(true)
  })
})

describe('plugin capability path budgets', () => {
  const atLimit = 'a'.repeat(PLUGIN_CAPABILITY_PATH_MAX_LENGTH)
  const overLimit = 'a'.repeat(PLUGIN_CAPABILITY_PATH_MAX_LENGTH + 1)

  it('accepts a pattern of exactly the maximum length and refuses one longer', () => {
    expect(pluginCapabilityPathSchema.safeParse(atLimit).success).toBe(true)
    expect(pluginCapabilityPathSchema.safeParse(overLimit).success).toBe(false)
  })

  it('bounds the input inside the predicate, before any regex rule runs', () => {
    // Why on the predicate directly: zod 4 accumulates issues across a
    // .max().superRefine() chain rather than aborting it, so the schema's own bound
    // is not what keeps an unbounded string away from the rules.
    expect(pluginCapabilityPathError(overLimit)).not.toBeNull()
    expect(pluginCapabilityPathError(atLimit)).toBeNull()
  })

  it('accepts a full pattern list and refuses one entry more', () => {
    const patterns = Array.from(
      { length: PLUGIN_CAPABILITY_PATH_LIMIT },
      (_, index) => `dir${index}/**`
    )

    expect(pluginCapabilityPathsSchema.safeParse(patterns).success).toBe(true)
    expect(pluginCapabilityPathsSchema.safeParse([...patterns, 'extra/**']).success).toBe(false)
  })
})
