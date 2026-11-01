import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH,
  NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH,
  NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH,
  isNativeChatVisualFileName,
  isPendingNativeChatVisualDirectiveTail,
  parseNativeChatVisualDirectiveLine,
  withoutNativeChatVisualDirectiveLines,
  withoutPendingNativeChatVisualDirectiveTail
} from './native-chat-visual-directive'

describe('parseNativeChatVisualDirectiveLine', () => {
  it('parses file and title', () => {
    expect(
      parseNativeChatVisualDirectiveLine(
        '::orca-visual{file="usage-3f2a.html" title="Usage by day"}'
      )
    ).toEqual({ file: 'usage-3f2a.html', title: 'Usage by day' })
  })

  it('treats title as optional and trims it', () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html"}')).toEqual({
      file: 'a.html',
      title: null
    })
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" title="  "}')).toEqual({
      file: 'a.html',
      title: null
    })
  })

  it('accepts attributes in any order, with spaces and tabs around them', () => {
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{ \ttitle="T"   file="a.html"\t }')
    ).toEqual({ file: 'a.html', title: 'T' })
  })

  it('accepts up to 3 leading spaces, trailing whitespace, and CRLF or LF endings', () => {
    expect(parseNativeChatVisualDirectiveLine('   ::orca-visual{file="a.html"}  \t\r\n')).toEqual({
      file: 'a.html',
      title: null
    })
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html"}\n')).not.toBeNull()
    expect(parseNativeChatVisualDirectiveLine('    ::orca-visual{file="a.html"}')).toBeNull()
    expect(parseNativeChatVisualDirectiveLine('\t::orca-visual{file="a.html"}')).toBeNull()
  })

  it('ignores unknown attributes but refuses a repeated one', () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" height="300"}')).toEqual(
      { file: 'a.html', title: null }
    )
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" file="b.html"}')
    ).toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{file="a.html" title="x" title="y"}')
    ).toBeNull()
  })

  it('keeps braces and markdown characters in a title verbatim', () => {
    expect(
      parseNativeChatVisualDirectiveLine(
        '::orca-visual{file="a.html" title="Cost {USD} *by* <team>"}'
      )
    ).toEqual({ file: 'a.html', title: 'Cost {USD} *by* <team>' })
  })

  it.each([
    ['missing file', '::orca-visual{title="T"}'],
    ['empty braces', '::orca-visual{}'],
    ['no braces', '::orca-visual'],
    ['unclosed', '::orca-visual{file="a.html"'],
    ['text after the line', '::orca-visual{file="a.html"} see above'],
    ['text before the marker', 'Chart: ::orca-visual{file="a.html"}'],
    ['wrong case', '::Orca-Visual{file="a.html"}'],
    ['single quotes', "::orca-visual{file='a.html'}"],
    ['unquoted value', '::orca-visual{file=a.html}'],
    ['escaped quote', '::orca-visual{file="a.html" title="say \\"hi\\""}'],
    ['backslash', '::orca-visual{file="a.html" title="a\\b"}'],
    ['control character', '::orca-visual{file="a.html" title="a\u0007b"}'],
    ['attributes glued together', '::orca-visual{file="a.html"title="T"}'],
    ['uppercase key', '::orca-visual{FILE="a.html"}'],
    ['embedded newline', '::orca-visual{file="a.html"\ntitle="T"}'],
    ['three colons', ':::orca-visual{file="a.html"}']
  ])('refuses %s', (_name, line) => {
    expect(parseNativeChatVisualDirectiveLine(line)).toBeNull()
  })

  it('refuses lines and titles past their length caps', () => {
    const title = 'x'.repeat(NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH)
    expect(
      parseNativeChatVisualDirectiveLine(`::orca-visual{file="a.html" title="${title}"}`)
    ).not.toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine(`::orca-visual{file="a.html" title="${title}x"}`)
    ).toBeNull()
    const padding = ' '.repeat(NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH)
    expect(parseNativeChatVisualDirectiveLine(`::orca-visual{file="a.html"}${padding}`)).toBeNull()
  })
})

describe('isNativeChatVisualFileName', () => {
  it.each(['a.html', 'usage-chart_3f2a.html', 'A1.b.html', '0.html'])('accepts %s', (name) => {
    expect(isNativeChatVisualFileName(name)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['no extension', 'chart'],
    ['other extension', 'chart.htm'],
    ['uppercase extension', 'chart.HTML'],
    ['markdown', 'chart.md'],
    ['directory', 'sub/chart.html'],
    ['backslash directory', 'sub\\chart.html'],
    ['parent', '../chart.html'],
    ['double dot inside', 'a..html'],
    ['leading dot', '.chart.html'],
    ['leading dash', '-chart.html'],
    ['absolute posix', '/tmp/chart.html'],
    ['drive', 'C:chart.html'],
    ['unc', '\\\\server\\share\\chart.html'],
    ['alternate stream', 'chart.html:stream'],
    ['space', 'my chart.html'],
    ['unicode', 'grafik-ä.html'],
    ['device name', 'con.html'],
    ['device name with dots', 'NUL.tar.html'],
    ['com port', 'COM1.html'],
    ['superscript com port', 'com¹.html'],
    ['too long', `${'a'.repeat(NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH - 4)}.html`]
  ])('refuses %s', (_name, name) => {
    expect(isNativeChatVisualFileName(name)).toBe(false)
  })

  it('accepts a name exactly at the length cap', () => {
    expect(
      isNativeChatVisualFileName(`${'a'.repeat(NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH - 5)}.html`)
    ).toBe(true)
  })
})

describe('streaming tail', () => {
  it.each([
    ':',
    '::',
    '::orca',
    '::orca-visual{',
    '::orca-visual{file="a.ht',
    '  ::orca-visual{file="a.html"}'
  ])('holds back %j', (line) => {
    expect(isPendingNativeChatVisualDirectiveTail(line)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'Here is a chart:',
    '::other',
    '::orca-visualx',
    '    ::orca-visual{',
    '- ::orca'
  ])('does not hold back %j', (line) => {
    expect(isPendingNativeChatVisualDirectiveTail(line)).toBe(false)
  })

  it('drops only the pending final line', () => {
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\n::orca-visual{file="a')).toBe(
      'Intro\n'
    )
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-vis')).toBe('')
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\nMore text')).toBe('Intro\nMore text')
    // A finished line (followed by a newline) is no longer the tail.
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-visual{file="a.html"}\n')).toBe(
      '::orca-visual{file="a.html"}\n'
    )
  })
})

describe('withoutNativeChatVisualDirectiveLines', () => {
  const LINE = '::orca-visual{file="usage.html" title="Usage"}'

  it('drops visual lines and the blank lines they leave behind', () => {
    expect(withoutNativeChatVisualDirectiveLines(`Here it is.\n\n${LINE}\n\nTuesday peaked.`)).toBe(
      'Here it is.\n\nTuesday peaked.'
    )
    expect(withoutNativeChatVisualDirectiveLines(`Intro\r\n${LINE}\r\n`)).toBe('Intro')
    expect(withoutNativeChatVisualDirectiveLines(LINE)).toBe('')
  })

  it('keeps the line inside fenced code and anything that is not a whole directive line', () => {
    const fenced = `\`\`\`\n${LINE}\n\`\`\`\nafter`
    expect(withoutNativeChatVisualDirectiveLines(fenced)).toBe(fenced)
    const tilde = `~~~~\n${LINE}\n~~~\nstill code\n~~~~`
    expect(withoutNativeChatVisualDirectiveLines(tilde)).toBe(tilde)
    expect(withoutNativeChatVisualDirectiveLines(`> ${LINE}`)).toBe(`> ${LINE}`)
    expect(withoutNativeChatVisualDirectiveLines(`See ${LINE}`)).toBe(`See ${LINE}`)
  })

  it('follows CommonMark fence rules: no info string on a closer, no backtick in an opener', () => {
    // ```js inside a block does not close it, so the visual line is still code.
    const notClosed = `\`\`\`\n\`\`\`js\n${LINE}\n\`\`\``
    expect(withoutNativeChatVisualDirectiveLines(notClosed)).toBe(notClosed)
    // Inline triple backticks open no fence, so a later visual line is still dropped.
    expect(withoutNativeChatVisualDirectiveLines(`Use \`\`\`a\`\`\` inline\n${LINE}`)).toBe(
      'Use ```a``` inline'
    )
  })

  it('leaves code blocks and indentation as written for a copy', () => {
    const code = '```\na\n\n\n\nb\n```'
    expect(withoutNativeChatVisualDirectiveLines(`${code}\n\n${LINE}`)).toBe(code)
    expect(withoutNativeChatVisualDirectiveLines(`    code\npara\n${LINE}`)).toBe('    code\npara')
    expect(withoutNativeChatVisualDirectiveLines(`${LINE}\n\nText`)).toBe('Text')
  })

  it('returns text without a marker untouched', () => {
    expect(withoutNativeChatVisualDirectiveLines('  plain\n\n\n text  ')).toBe(
      '  plain\n\n\n text  '
    )
  })
})
