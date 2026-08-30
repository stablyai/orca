import { describe, expect, it } from 'vitest'
import { sanitizeCrashReportString } from './crash-report-redaction'

/**
 * Why: a crash report leaves the machine. Each pattern below is the only thing standing between
 * a real secret or a real filesystem path and the report body, and neutering either of these two
 * used to leave the whole suite green.
 */

const API_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const UNC_WITH_SPACE = 'open "\\\\fileserver\\Private Share\\brennan\\creds.txt" failed'

describe('sanitizeCrashReportString', () => {
  it('redacts a bare sk- API key that no assignment keyword introduces', () => {
    const sanitized = sanitizeCrashReportString(`Request failed for API key ${API_KEY} (401)`)

    expect(sanitized).not.toContain(API_KEY)
    expect(sanitized).not.toContain('sk-ant-api03')
    expect(sanitized).toContain('[redacted-secret]')
  })

  it('redacts a quoted UNC path whose segments contain spaces', () => {
    const sanitized = sanitizeCrashReportString(UNC_WITH_SPACE)

    expect(sanitized).not.toContain('Private Share')
    expect(sanitized).not.toContain('creds.txt')
    expect(sanitized).toContain('[redacted-path]')
  })

  // Positive control: prose that resembles neither must survive, so the assertions above
  // cannot pass by redacting everything.
  it('leaves text carrying no secret and no path untouched', () => {
    const prose = 'Renderer crashed while restoring 3 tabs after a sk- prefixed heading'

    expect(sanitizeCrashReportString(prose)).toBe(prose)
  })
})

/**
 * Why: the unquoted patterns used to stop at the first space, emitting [redacted-path] with the
 * rest of the path still beside it -- a report that looks scrubbed but still carries a share name,
 * a directory chain and a filename. Each form below is pinned to go whole.
 */
const PARTIAL_LEAK_FORMS: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'unquoted UNC, one space',
    'open \\\\fileserver\\Private Share\\brennan\\creds.txt failed',
    ['Private Share', 'brennan', 'creds.txt']
  ],
  [
    'unquoted UNC, two spaces',
    'open \\\\fileserver\\Very Private Share\\creds.txt failed',
    ['Very Private Share', 'creds.txt']
  ],
  [
    'unquoted drive letter',
    'load C:\\Users\\brennan\\My Documents\\creds.txt failed',
    ['Users', 'brennan', 'My Documents', 'creds.txt']
  ],
  [
    'unquoted POSIX',
    'read /Users/brennan/My Documents/creds.txt failed',
    ['brennan', 'My Documents', 'creds.txt']
  ],
  [
    'unquoted POSIX, backslash-escaped space',
    'read /Users/brennan/My\\ Documents/creds.txt failed',
    ['brennan', 'Documents', 'creds.txt']
  ],
  [
    'environment-variable root',
    'open %APPDATA%\\Orca App Data\\creds.txt failed',
    ['Orca App Data', 'creds.txt']
  ],
  // A space inside the *last* segment: what survived here carried no separator, which is why the
  // invariant below had to grow a second shape to see it.
  [
    'unquoted POSIX, space in the filename',
    'read /Users/brennan/Documents/My Notes.txt failed',
    ['brennan', 'Documents', 'My Notes', 'Notes.txt']
  ],
  [
    'unquoted drive letter, space in the filename',
    'load C:\\Users\\brennan\\Documents\\My Notes.txt failed',
    ['brennan', 'Documents', 'My Notes', 'Notes.txt']
  ],
  [
    'unquoted UNC, space in the filename',
    'open \\\\fileserver\\share\\My Notes.txt failed',
    ['fileserver', 'share', 'My Notes', 'Notes.txt']
  ],
  [
    'unquoted POSIX, spaces in both a folder and the filename',
    'read /Users/brennan/My Documents/My Notes.txt failed',
    ['brennan', 'My Documents', 'My Notes', 'Notes.txt']
  ],
  // A directory chain ending in no filename at all: the run that continues it carries separators
  // and nothing else, so a chain has to count as path evidence on its own.
  [
    'spaced directory chain, no filename',
    'watcher failed on \\\\nas01\\Team Share\\orca\\workspace and fell back to polling',
    ['nas01', 'Team Share', 'orca', 'workspace']
  ],
  [
    'POSIX path inside a stack frame',
    '    at load (/Users/brennan/My Documents/app.js:12:9)',
    ['brennan', 'My Documents', 'app.js']
  ],
  [
    'drive-letter path inside a stack frame',
    '    at load (C:\\Users\\brennan\\My Documents\\app.js:12:9)',
    ['brennan', 'My Documents', 'app.js']
  ]
]

describe('sanitizeCrashReportString path redaction is all-or-nothing', () => {
  it.each(PARTIAL_LEAK_FORMS)('redacts %s whole', (_name, input, fragments) => {
    const sanitized = sanitizeCrashReportString(input)

    expect(sanitized).toContain('[redacted-path]')
    for (const fragment of fragments) {
      expect(sanitized).not.toContain(fragment)
    }
    // The defect shape: a marker sitting next to surviving path content. A separator after the
    // marker catches a path cut mid-chain. It cannot see a cut inside the last segment -- what
    // survives there is a bare filename, 'My Notes.txt' cut to 'Notes.txt' -- so a name carrying an
    // extension beside the marker is forbidden too.
    expect(sanitized).not.toMatch(/\[redacted-path\][^\n]*[\\/]/)
    expect(sanitized).not.toMatch(/\[redacted-path\] ?\S*\.[A-Za-z0-9]/)
  })

  // Control for the space-crossing rule specifically: it must not swallow the prose that follows a
  // path, or these pins could pass by redacting the rest of every line.
  it.each([
    [
      'plain prose',
      'read /Users/brennan/Documents/creds.txt but the disk was full',
      'but the disk was full'
    ],
    [
      'sentence break',
      'read /etc/hosts. Then it failed and/or retried',
      'Then it failed and/or retried'
    ],
    [
      'following URL',
      'read /etc/hosts then see https://example.com for help',
      'then see https://example.com for help'
    ],
    // A separator in the prose is not a path continuing: 'and/or' and 'read/write' carry one and
    // are words. The crossing reads them as prose because neither ends in a name.
    [
      'slash in the words that follow',
      'read /Users/brennan/Documents/creds.txt but read/write failed',
      'but read/write failed'
    ],
    [
      'slash in the words that follow, no sentence break',
      'read /etc/hosts then it failed and/or retried',
      'then it failed and/or retried'
    ],
    // A hostname is spelled like a filename. It is only reachable across plain words, and a name
    // alone continues a path only when every run before it carries a separator.
    [
      'host that reads like a filename',
      'read /etc/hosts then reach api.example.com for the status',
      'then reach api.example.com for the status'
    ],
    // A separator alone is not enough, one run away or several: a run has to reach a name or a
    // second separator, and the window it is looked for in is two runs wide.
    [
      'slash in the very next words',
      'read /etc/hosts or read/write failed',
      'or read/write failed'
    ],
    [
      'path-shaped words further along the sentence',
      'read /etc/hosts before the retry loop reached src/net/socket.js',
      'before the retry loop reached src/net/socket.js'
    ],
    // A name ends a path, so nothing after a filename is read as more of it.
    [
      'path-shaped words after a filename',
      'read /Users/brennan/Documents/creds.txt then check b/c/d.txt now',
      'then check b/c/d.txt now'
    ]
  ])('keeps the prose after a redacted path (%s)', (_name, input, survives) => {
    expect(sanitizeCrashReportString(input)).toBe(`read [redacted-path] ${survives}`)
  })

  // Three things hold a path's spaces to one path. Each is a single character or bound in one
  // pattern, each ablates to a silent collapse, and none of the rows above sees it go.
  it.each([
    [
      'both ending in a filename',
      'moved /Users/alice/My Docs/a.txt to /Users/bob/My Docs/b.txt and retried',
      'moved [redacted-path] to [redacted-path] and retried'
    ],
    [
      'the first ending in a folder',
      'copied /Users/alice/My Docs/logs/app to /Users/bob/My Docs/b.txt now',
      'copied [redacted-path] to [redacted-path] now'
    ]
  ])('keeps two paths on one line two paths (%s)', (_name, input, expected) => {
    expect(sanitizeCrashReportString(input)).toBe(expected)
  })

  it('keeps two stack frames on one line two frames', () => {
    const sanitized = sanitizeCrashReportString(
      'at load (/Users/alice/My Docs/a.js:12:9) at emit (/Users/bob/My Docs/b.js:1:1)'
    )

    expect(sanitized).toBe('at load ([redacted-path]) at emit ([redacted-path])')
  })

  it.each([
    [
      'the next line holding its own path',
      'read /Users/alice/My Docs/a.txt\nand then /Users/bob/My Docs/b.txt failed',
      'read [redacted-path]\nand then [redacted-path] failed'
    ],
    [
      'the next line opening with path-shaped text',
      'read /Users/alice/Documents\nBackups/My Notes.txt failed',
      'read [redacted-path]\nBackups/My Notes.txt failed'
    ]
  ])('stops a path at the end of its line (%s)', (_name, input, expected) => {
    expect(sanitizeCrashReportString(input)).toBe(expected)
  })

  // A crash report carries minified frames, serialised state and base64 blobs, all on one line. The
  // crossing looks ahead over a bounded window for that reason: scanning to the end of the line at
  // every space made a 100KB line cost over a second. The budget is ~250x the measured cost, so it
  // fails on a return to quadratic rather than on a slow machine.
  it.each([
    ['a line of many paths', '/opt/orca/logs/frame.js '.repeat(4_260)],
    ['a few runs carrying many separators', `/opt/o/a ${`${'x/'.repeat(3_000)} `.repeat(8)}`]
  ])('sanitises a very long single line in bounded time (%s)', (_name, line) => {
    expect(line.length).toBeGreaterThan(45_000)

    const startedAt = performance.now()
    sanitizeCrashReportString(line, 4_000)

    expect(performance.now() - startedAt).toBeLessThan(250)
  })
})
