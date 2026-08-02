export type PastePayloadCorpusCase = {
  hasRichText?: boolean
  name: string
  text: string
  expected: {
    hasControlSequences: boolean
    lineCount: number
  }
}

const GRAVE_ACCENT = String.fromCharCode(0x60)

// Why: paste safety tests should exercise the same risky payload shapes
// without snapshotting or logging clipboard-like content.
export const PASTE_PAYLOAD_CORPUS: PastePayloadCorpusCase[] = [
  {
    name: 'simple text',
    text: 'simple text',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'single line with spaces',
    text: 'single line with several spaces',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'multiline LF',
    text: 'alpha\nbeta\ngamma',
    expected: { hasControlSequences: false, lineCount: 3 }
  },
  {
    name: 'multiline CRLF',
    text: 'alpha\r\nbeta\r\ngamma',
    expected: { hasControlSequences: false, lineCount: 3 }
  },
  {
    name: 'mixed newline text',
    text: 'alpha\r\nbeta\ngamma\rdelta',
    expected: { hasControlSequences: false, lineCount: 4 }
  },
  {
    name: 'PowerShell metacharacters',
    text: ['PowerShell: ', GRAVE_ACCENT, ' $ " \' ; | & < > @ { } ( )'].join(''),
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'cmd metacharacters',
    text: 'cmd: %PATH% !VAR! ^ & | < >',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'POSIX shell metacharacters',
    text: ['POSIX: $ ', GRAVE_ACCENT, ' " \' ; | & < > * ? [ ] ( )'].join(''),
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'Windows path with spaces',
    text: 'C:\\Users\\Name\\My Project\\file.txt',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'UNC path',
    text: '\\\\server\\share\\folder\\file.txt',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'WSL UNC path',
    text: '\\\\wsl$\\Ubuntu-24.04\\home\\user\\repo',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'POSIX path with spaces',
    text: '/home/user/my project/file.txt',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'Unicode',
    text: 'café 你好 مرحبا 😀',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'RTL and combining marks',
    text: 'עברית e\u0301 عربى',
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'long single line',
    text: 'x'.repeat(1024),
    expected: { hasControlSequences: false, lineCount: 1 }
  },
  {
    name: 'large multiline text',
    text: Array.from({ length: 32 }, (_value, index) => ['line-', String(index)].join('')).join(
      '\n'
    ),
    expected: { hasControlSequences: false, lineCount: 32 }
  },
  {
    name: 'ANSI control sequence',
    text: 'before\x1b[31mafter',
    expected: { hasControlSequences: true, lineCount: 1 }
  },
  {
    name: 'browser rich-text plain fallback',
    text: 'Heading\nplain text fallback',
    hasRichText: true,
    expected: { hasControlSequences: false, lineCount: 2 }
  }
]
