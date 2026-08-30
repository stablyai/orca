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

  // Positive control: text that resembles neither must survive, so the assertions above cannot pass
  // by redacting everything. The later rows are the near-misses -- a tilde that roots no path, and a
  // URL whose path names a server rather than this disk.
  it.each([
    'Renderer crashed while restoring 3 tabs after a sk- prefixed heading',
    'throughput was ~5s/op after the retry',
    'cache~v2/entries/cold was empty',
    'POST https://api.example.com/v1/messages returned 500',
    'require node:fs and npm:left-pad'
  ])('leaves text carrying no secret and no path untouched: %s', (prose) => {
    expect(sanitizeCrashReportString(prose)).toBe(prose)
  })
})

/**
 * Why: a path reaches a report in more shapes than the bare patterns can see. The unquoted patterns
 * used to stop at the first space, emitting [redacted-path] with the rest of the path still beside
 * it; the URL and tilde forms below were missed outright, so a username left the machine untouched.
 * Each form is pinned to go whole -- marker emitted and content removed in one operation.
 */
const LEAKED_PATH_FORMS: readonly (readonly [string, string, readonly string[]])[] = [
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
  // A dot is not only a filename's. It sits inside folder names too -- a version, a date -- and
  // reading one as the path's end shipped every segment after it.
  [
    'unquoted POSIX, a dot inside a spaced folder name',
    'read /Users/brennan/Release 1.0 Notes/creds.txt failed',
    ['brennan', 'Release 1.0 Notes', 'creds.txt']
  ],
  [
    'unquoted drive letter, a dot inside a spaced folder name',
    'load C:\\Users\\brennan\\Orca v1.2 beta\\creds.txt failed',
    ['brennan', 'Orca v1.2 beta', 'creds.txt']
  ],
  // An extension is as long as its format made it. The eight-character bound that used to end the
  // path here is shorter than the ones macOS, iOS and Java hand out every day.
  [
    'unquoted POSIX, an extension longer than eight characters',
    'read /Users/brennan/My App.entitlements failed',
    ['brennan', 'My App', 'App.entitlements']
  ],
  [
    'unquoted drive letter, an extension longer than eight characters',
    'load C:\\Users\\brennan\\Work Files\\App.xcodeproj failed',
    ['brennan', 'Work Files', 'App.xcodeproj']
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
  ],
  // URL-shaped roots. A renderer stack is file:// throughout, so this is the form a crash report is
  // most likely to carry -- and the one that used to survive redaction entirely.
  [
    'file URL',
    'load file:///Users/alice/Documents/app.js failed',
    ['alice', 'Documents', 'app.js']
  ],
  [
    'file URL inside a stack frame',
    '    at load (file:///Users/alice/My Documents/app.js:12:9)',
    ['alice', 'My Documents', 'app.js']
  ],
  [
    'quoted file URL',
    'load "file:///Users/alice/My Documents/app.js" failed',
    ['alice', 'My Documents', 'app.js']
  ],
  [
    'file URL rooted at a drive',
    'load file:///C:/Users/alice/Documents/app.js failed',
    ['Users', 'alice', 'Documents']
  ],
  [
    'file URL naming a host',
    'load file://fileserver/Private Share/alice/creds.txt failed',
    ['fileserver', 'Private Share', 'alice', 'creds.txt']
  ],
  ['file URL without an authority', 'load file:/Users/alice/app.js failed', ['alice', 'app.js']],
  [
    'file URL with an uppercase scheme',
    'load FILE:///Users/alice/Documents/app.js failed',
    ['alice', 'Documents', 'app.js']
  ],
  [
    'editor deep link',
    'open vscode://file/Users/alice/Documents/app.ts:3 failed',
    ['alice', 'Documents', 'app.ts']
  ],
  ['app scheme URL', 'load app:///Users/alice/dist/index.js failed', ['alice', 'dist']],
  [
    'share URL',
    'mount smb://fileserver/Private Share/alice/creds.txt failed',
    ['fileserver', 'Private Share', 'alice', 'creds.txt']
  ],
  // A scheme stacked on another: matching from the inner one left the driver beside the marker,
  // 'jdbc:[redacted-path]', which the invariant below reads as a root still standing.
  [
    'database URL behind a driver scheme',
    'connect jdbc:postgresql://db.internal:5432/orca failed',
    ['db.internal', '5432', 'orca']
  ],
  [
    'database URL behind a driver scheme, uppercased',
    'connect JDBC:MySQL://db.internal:3306/appdb failed',
    ['db.internal', '3306', 'appdb']
  ],
  // What precedes a scheme is not always another scheme. Refusing to start after punctuation would
  // leave these paths whole.
  [
    'file URL behind a colon that is no scheme',
    'at line 12:file:///Users/alice/Documents/secret.js here',
    ['alice', 'Documents', 'secret.js']
  ],
  [
    'file URL behind a version that is no scheme',
    'orca 1.2.3-file:///Users/alice/Documents/secret.js here',
    ['alice', 'Documents', 'secret.js']
  ],
  // Roots the bare patterns cannot start from: a tilde home, and a drive spelled with forward slashes.
  [
    'tilde home',
    'read ~/Documents/My Notes/creds.txt failed',
    ['Documents', 'My Notes', 'creds.txt']
  ],
  [
    'tilde home of a named user',
    'read ~alice/Documents/creds.txt failed',
    ['alice', 'Documents', 'creds.txt']
  ],
  [
    'drive letter with forward slashes',
    'open C:/Users/alice/My Documents/creds.txt failed',
    ['Users', 'alice', 'My Documents', 'creds.txt']
  ],
  [
    'quoted drive letter with forward slashes',
    'open "C:/Users/alice/My Documents/creds.txt" failed',
    ['Users', 'alice', 'My Documents', 'creds.txt']
  ]
]

describe('sanitizeCrashReportString path redaction is all-or-nothing', () => {
  it.each(LEAKED_PATH_FORMS)('redacts %s whole', (_name, input, fragments) => {
    const sanitized = sanitizeCrashReportString(input)

    expect(sanitized).toContain('[redacted-path]')
    for (const fragment of fragments) {
      expect(sanitized).not.toContain(fragment)
    }
    // The defect shape: a marker sitting next to surviving path content. A separator after the
    // marker catches a path cut mid-chain. It cannot see a cut inside the last segment -- what
    // survives there is a bare filename, 'My Notes.txt' cut to 'Notes.txt' -- so a name carrying an
    // extension beside the marker is forbidden too. Leading covers a root left standing where the
    // marker begins -- 'file:///C:[redacted-path]', 'C:[redacted-path]', '~[redacted-path]',
    // 'jdbc:[redacted-path]' -- which still names where the file lived. A root is a separator, a
    // tilde or a scheme; a bare ':' is not one, or a frame's 'line 12:' would read as a root.
    expect(sanitized).not.toMatch(/\[redacted-path\][^\n]*[\\/]/)
    expect(sanitized).not.toMatch(/\[redacted-path\] ?\S*\.[A-Za-z0-9]/)
    expect(sanitized).not.toMatch(
      /[\\/~][^\s]*\[redacted-path\]|[A-Za-z][A-Za-z0-9+.-]*:\[redacted-path\]/
    )
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
    ],
    // The URL rule must not reach a remote resource: a web-transport path names a server's route,
    // not this machine's disk, and redacting it would cost the report its failing endpoint.
    [
      'remote https URL carrying a path',
      'read /etc/hosts then POST https://api.example.com/v1/messages',
      'then POST https://api.example.com/v1/messages'
    ],
    [
      'websocket URL carrying a path',
      'read /etc/hosts then ws://127.0.0.1:9229/devtools/page/ABC',
      'then ws://127.0.0.1:9229/devtools/page/ABC'
    ],
    [
      'dev server URL carrying a path',
      'read /etc/hosts then GET http://localhost:5173/src/main.tsx',
      'then GET http://localhost:5173/src/main.tsx'
    ],
    [
      'scheme that names no path',
      'read /etc/hosts then require node:fs and npm:left-pad',
      'then require node:fs and npm:left-pad'
    ],
    [
      'git remote over ssh',
      'read /etc/hosts then push git@github.com:orgname/reponame.git',
      'then push git@github.com:orgname/reponame.git'
    ],
    [
      'remote URL whose scheme is uppercased',
      'read /etc/hosts then POST HTTPS://api.example.com/v1/messages',
      'then POST HTTPS://api.example.com/v1/messages'
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
  // every space made a 100KB line cost over a second. The budget is ~150x the measured cost (1.3ms
  // against 250ms), so it fails on a return to quadratic rather than on a slow machine.
  it.each([
    ['a line of many paths', '/opt/orca/logs/frame.js '.repeat(4_260)],
    ['a few runs carrying many separators', `/opt/o/a ${`${'x/'.repeat(6_000)} `.repeat(8)}`]
  ])('sanitises a very long single line in bounded time (%s)', (_name, line) => {
    expect(line.length).toBeGreaterThan(45_000)

    const startedAt = performance.now()
    sanitizeCrashReportString(line, 4_000)

    expect(performance.now() - startedAt).toBeLessThan(250)
  })
})

/**
 * Why: every rule holding a path's spaces to that path is one character class or one bound, and any
 * of them that no row watches can be deleted or tightened with the suite still green -- which is how
 * a bound whose tight side drops long paths, and a guard holding an undecided question open, both
 * went unpinned. Each row is the measured output of ablating exactly one element.
 */
describe('sanitizeCrashReportString pins each element of the space-crossing rule', () => {
  it.each([
    // A quote ends an unquoted path, so a quoted path beside one keeps its closing delimiter.
    [
      'a quote ends the unquoted path',
      'read /Users/brennan/a.txt "quoted /Users/alice/c.txt" tail',
      'read [redacted-path] "quoted [redacted-path]" tail'
    ],
    // The window is two runs wide. Tightened, a four-word folder name ships from its second word.
    [
      'a folder name of four words',
      'read /Users/brennan/A B C D/creds.txt failed',
      'read [redacted-path] failed'
    ],
    // The scheme stack is matched with the path, three deep, or a driver is left naming the host.
    [
      'a path behind three stacked schemes',
      'connect a:jdbc:postgresql://db.internal:5432/orca failed',
      'connect [redacted-path] failed'
    ],
    // A name has to end its token. Without that, a dotted suffix on a word in the prose reads as a
    // filename and the sentence carrying it is redacted along with the path.
    [
      'prose carrying a separator and a dotted suffix',
      'read /etc/hosts see docs/api.md#anchor for detail',
      'read [redacted-path] see docs/api.md#anchor for detail'
    ]
  ])('%s', (_name, input, expected) => {
    expect(sanitizeCrashReportString(input)).toBe(expected)
  })

  // The run bound is the longest segment a filesystem hands back: 255 on APFS, NTFS and ext4. Both
  // sides are pinned -- tightening it drops a legal path, widening it returns the quadratic.
  it('crosses a space into a segment as long as a filesystem allows', () => {
    const segment = 'n'.repeat(255)

    expect(
      sanitizeCrashReportString(`read /Users/brennan/Team ${segment}/creds.txt failed`, 4_000)
    ).toBe('read [redacted-path] failed')
  })

  it('gives up on a segment longer than a filesystem allows', () => {
    const segment = 'n'.repeat(300)

    expect(
      sanitizeCrashReportString(`read /Users/brennan/Team ${segment}/creds.txt failed`, 4_000)
    ).toBe(`read [redacted-path] ${segment}/creds.txt failed`)
  })

  // Parked, awaiting a decision: sentence punctuation inside a folder name. The path stops there and
  // the segments after it ship. Crossing it eats the prose that follows a path instead -- 'failed:
  // /Users/alice/a.js; retry with lib/x/y.js' loses its second half -- so the guard stays until that
  // is settled, pinned so that deleting a character class cannot settle it by accident.
  it.each([
    [
      'a comma',
      'read /Users/brennan/Notes, Drafts/creds.txt failed',
      'read [redacted-path] Drafts/creds.txt failed'
    ],
    [
      'a semicolon',
      'read /Users/brennan/A; B/creds.txt failed',
      'read [redacted-path] B/creds.txt failed'
    ],
    [
      'an exclamation mark',
      'read /Users/brennan/Wow! Notes/creds.txt failed',
      'read [redacted-path] Notes/creds.txt failed'
    ]
  ])(
    'stops a path where a folder name carries sentence punctuation (%s)',
    (_name, input, expected) => {
      expect(sanitizeCrashReportString(input)).toBe(expected)
    }
  )

  // KNOWN LEAK, accepted and awaiting the same decision. A spaced final segment whose extension is
  // followed by something that is not itself an extension ('.txt-bak', '.txt~') is not a name to
  // this rule, so the path ends before it and the filename ships beside the marker. These rows are
  // the leak, not the fix: they hold the measured output so it cannot change unnoticed.
  // It is the trailing lookahead on the name that leaks here, and the same lookahead is the only
  // thing keeping 'see docs/api.md#anchor for detail' out of the redaction -- one element, two
  // directions, which is why this waits on replacing the pattern with per-token classification
  // rather than on a wider character class. Ablating that lookahead reddens all three rows at once.
  it.each([
    [
      'a suffix after the extension',
      'read /Users/brennan/My Notes.txt-bak failed',
      'read [redacted-path] Notes.txt-bak failed'
    ],
    [
      'an editor backup marker',
      'read /Users/brennan/My Notes.txt~ failed',
      'read [redacted-path] Notes.txt~ failed'
    ]
  ])(
    'leaks a filename carrying a non-extension suffix (known limit) (%s)',
    (_name, input, expected) => {
      expect(sanitizeCrashReportString(input)).toBe(expected)
    }
  )

  // The leak's boundary: a further dot is itself an extension, so a double-extension filename is a
  // name and goes whole. Without this the limit above reads wider than it is.
  it.each([
    ['a double extension', 'read /Users/brennan/My Notes.tar.gz failed'],
    ['a dotted backup suffix', 'read /Users/brennan/My Notes.txt.bak failed']
  ])('redacts a spaced filename carrying a second extension whole (%s)', (_name, input) => {
    expect(sanitizeCrashReportString(input)).toBe('read [redacted-path] failed')
  })
})
