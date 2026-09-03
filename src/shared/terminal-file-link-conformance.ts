export type TerminalFileLinkTapExpectation = {
  pathText: string
  line: number | null
  column: number | null
}

export type TerminalFileLinkTapConformanceCase = {
  name: string
  lineText: string
  tapText: string
  expected: TerminalFileLinkTapExpectation | null
}

export function columnForTerminalFileLinkTap(testCase: TerminalFileLinkTapConformanceCase): number {
  const column = testCase.lineText.indexOf(testCase.tapText)
  if (column === -1) {
    throw new Error(`Tap text "${testCase.tapText}" not found in "${testCase.lineText}"`)
  }
  return column
}

export const TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES: TerminalFileLinkTapConformanceCase[] = [
  {
    name: 'absolute path',
    lineText: 'created /tmp/out/report.html for you',
    tapText: 'report',
    expected: { pathText: '/tmp/out/report.html', line: null, column: null }
  },
  {
    name: 'relative path with line and column',
    lineText: 'see src/components/Button.tsx:12:7 here',
    tapText: 'Button',
    expected: { pathText: 'src/components/Button.tsx', line: 12, column: 7 }
  },
  {
    name: 'relative markdown path with line',
    lineText: 'documented in docs/terminal-scroll-intent-architecture.md:230',
    tapText: 'terminal-scroll',
    expected: {
      pathText: 'docs/terminal-scroll-intent-architecture.md',
      line: 230,
      column: null
    }
  },
  {
    name: 'tilde path',
    lineText: 'wrote ~/Documents/notes.md',
    tapText: 'notes',
    expected: { pathText: '~/Documents/notes.md', line: null, column: null }
  },
  {
    name: 'directory segment containing a space',
    lineText: '/Users/me/My Project/readme.md done',
    tapText: 'readme',
    expected: { pathText: '/Users/me/My Project/readme.md', line: null, column: null }
  },
  {
    name: 'spaced path with line and column',
    lineText: 'wrote /tmp/orca report/result.json:12:3 for you',
    tapText: 'result',
    expected: { pathText: '/tmp/orca report/result.json', line: 12, column: 3 }
  },
  {
    name: 'spaced path with dotted directory',
    lineText: 'wrote /tmp/v1.2 reports/result.json for you',
    tapText: 'v1.2',
    expected: { pathText: '/tmp/v1.2 reports/result.json', line: null, column: null }
  },
  {
    name: 'spaced path with dotted directory at line end',
    lineText: 'wrote /tmp/v1.2 reports/result.json',
    tapText: 'result',
    expected: { pathText: '/tmp/v1.2 reports/result.json', line: null, column: null }
  },
  {
    name: 'spaced path at line end',
    lineText: 'wrote /tmp/final report.json',
    tapText: 'report',
    expected: { pathText: '/tmp/final report.json', line: null, column: null }
  },
  {
    name: 'path followed by prose ending in a filename',
    lineText: '/var/log/app.log failed to start app.py',
    tapText: 'app.log',
    expected: { pathText: '/var/log/app.log', line: null, column: null }
  },
  {
    name: 'trailing prose filename stays its own tap target',
    lineText: '/var/log/app.log failed to start app.py',
    tapText: 'app.py',
    expected: { pathText: 'app.py', line: null, column: null }
  },
  {
    name: 'relative path followed by prose ending in a filename',
    lineText: 'src/main.ts uses config.yaml',
    tapText: 'main',
    expected: { pathText: 'src/main.ts', line: null, column: null }
  },
  {
    name: 'spaced filename',
    lineText: 'wrote /tmp/final report.json for you',
    tapText: 'report',
    expected: { pathText: '/tmp/final report.json', line: null, column: null }
  },
  {
    name: 'spaced path ending in a dotfile',
    lineText: 'wrote /tmp/My Project/.env for you',
    tapText: '.env',
    expected: { pathText: '/tmp/My Project/.env', line: null, column: null }
  },
  {
    name: 'first of two spaced candidates',
    lineText: 'see /tmp/a.txt and /tmp/b.txt done',
    tapText: 'a.txt',
    expected: { pathText: '/tmp/a.txt', line: null, column: null }
  },
  {
    name: 'second of two spaced candidates',
    lineText: 'see /tmp/a.txt and /tmp/b.txt done',
    tapText: 'b.txt',
    expected: { pathText: '/tmp/b.txt', line: null, column: null }
  },
  {
    name: 'surrounding punctuation',
    lineText: 'open (src/a.ts) now',
    tapText: 'a.ts',
    expected: { pathText: 'src/a.ts', line: null, column: null }
  },
  {
    name: 'bare filename with extension',
    lineText: 'Here you go: README.md',
    tapText: 'README',
    expected: { pathText: 'README.md', line: null, column: null }
  },
  {
    name: 'plain prose word',
    lineText: 'just some prose with no path here',
    tapText: 'prose',
    expected: null
  },
  // A glued particle is not always followed by a space: punctuation, ASCII, and CJK
  // brackets all close the citation, and a letters-only trim never fires there.
  {
    name: 'particle then full-width parenthesis',
    lineText: 'plans/foo.mdを(参照) 確認',
    tapText: 'foo',
    expected: { pathText: 'plans/foo.md', line: null, column: null }
  },
  {
    name: 'particle then ascii tail',
    lineText: 'plans/foo.mdへabc',
    tapText: 'foo',
    expected: { pathText: 'plans/foo.md', line: null, column: null }
  },
  {
    name: 'cjk closing bracket after extension',
    lineText: 'docs/日本語.md」を 参照',
    tapText: '日本語',
    expected: { pathText: 'docs/日本語.md', line: null, column: null }
  },
  // Prose glues onto the left as readily as the right.
  {
    name: 'prose glued before a bare filename',
    lineText: '文書はREADME.mdだ',
    tapText: 'README',
    expected: { pathText: 'README.md', line: null, column: null }
  },
  {
    name: 'prose glued before a separator path',
    lineText: '参照docs/文書.md を見て',
    tapText: 'docs/',
    expected: { pathText: 'docs/文書.md', line: null, column: null }
  },
  // Two relative paths on one line must stay separate; they used to merge into a
  // span that resolved to nothing and killed both.
  {
    name: 'two relative paths, first',
    lineText: 'docs/a.md see docs/b.md',
    tapText: 'a.md',
    expected: { pathText: 'docs/a.md', line: null, column: null }
  },
  {
    name: 'two relative paths, second',
    lineText: 'docs/a.md see docs/b.md',
    tapText: 'b.md',
    expected: { pathText: 'docs/b.md', line: null, column: null }
  },
  // Only at a non-ASCII -> ASCII boundary: a wholly non-Latin name is a real name.
  {
    name: 'wholly non-latin name stays whole',
    lineText: '参照文書.md を見て',
    tapText: '参照',
    expected: { pathText: '参照文書.md', line: null, column: null }
  }
]
