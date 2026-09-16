import { describe, expect, it } from 'vitest'
import { stripTerminalSelectionGutter } from './terminal-selection-gutter'

// Shape agent CLIs paint: a marker column, then continuation lines behind a
// two-space gutter. Selecting the body is what users copy to paste elsewhere.
const AGENT_MESSAGE_BODY = [
  '  Thanks for flagging this. The retry limit is now 5, and the backoff',
  '  starts at 2s instead of 500ms.',
  '',
  '  Let me know if anything still looks off.'
].join('\n')

describe('stripTerminalSelectionGutter', () => {
  it('drops the gutter agent output is painted behind', () => {
    expect(stripTerminalSelectionGutter(AGENT_MESSAGE_BODY)).toBe(
      [
        'Thanks for flagging this. The retry limit is now 5, and the backoff',
        'starts at 2s instead of 500ms.',
        '',
        'Let me know if anything still looks off.'
      ].join('\n')
    )
  })

  it('drops the gutter from a single wrapped line', () => {
    expect(stripTerminalSelectionGutter('  one logical line, joined by xterm')).toBe(
      'one logical line, joined by xterm'
    )
  })

  it('keeps relative indentation inside the gutter', () => {
    const nested = ['  def run():', '      return 1', '', '  run()'].join('\n')
    expect(stripTerminalSelectionGutter(nested)).toBe(
      ['def run():', '    return 1', '', 'run()'].join('\n')
    )
  })

  it('leaves a selection that starts mid-line untouched', () => {
    const midLine = ['answer starts here', '  and continues', '  and ends'].join('\n')
    expect(stripTerminalSelectionGutter(midLine)).toBe(midLine)
  })

  it('leaves unindented output untouched', () => {
    const shellOutput = ['$ git status', 'On branch main', 'nothing to commit'].join('\n')
    expect(stripTerminalSelectionGutter(shellOutput)).toBe(shellOutput)
  })

  it('ignores blank lines when measuring the gutter', () => {
    expect(stripTerminalSelectionGutter(['  a', '', '  b'].join('\n'))).toBe(
      ['a', '', 'b'].join('\n')
    )
  })

  it('ignores whitespace-only lines when measuring the gutter', () => {
    expect(stripTerminalSelectionGutter(['    a', ' ', '    b'].join('\n'))).toBe(
      ['a', '', 'b'].join('\n')
    )
  })

  it('leaves an all-whitespace selection untouched', () => {
    expect(stripTerminalSelectionGutter('   \n  \n')).toBe('   \n  \n')
  })

  it('preserves the CRLF joins xterm emits on Windows', () => {
    expect(stripTerminalSelectionGutter('  first\r\n  second\r\n')).toBe('first\r\nsecond\r\n')
  })

  // Regression: a blank CRLF row is '\r', which reads as a zero-indent content
  // row unless the CR is split off first — that would cancel the gutter on
  // Windows only.
  it('still finds the gutter across a blank CRLF row', () => {
    expect(stripTerminalSelectionGutter('  first\r\n\r\n  second\r\n')).toBe(
      'first\r\n\r\nsecond\r\n'
    )
  })

  it('leaves wide characters and emoji in the content alone', () => {
    expect(
      stripTerminalSelectionGutter(['  変更を適用しました 🎉', '  お疲れさま'].join('\n'))
    ).toBe(['変更を適用しました 🎉', 'お疲れさま'].join('\n'))
  })

  it('does not strip past a shorter line', () => {
    const uneven = ['    deep', '  shallow'].join('\n')
    expect(stripTerminalSelectionGutter(uneven)).toBe(['  deep', 'shallow'].join('\n'))
  })

  it('is a no-op on an empty selection', () => {
    expect(stripTerminalSelectionGutter('')).toBe('')
  })

  it('leaves tab-indented text alone (terminal cells never hold tabs)', () => {
    const tabbed = ['\tone', '\ttwo'].join('\n')
    expect(stripTerminalSelectionGutter(tabbed)).toBe(tabbed)
  })
})
