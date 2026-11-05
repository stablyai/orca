import { describe, expect, it } from 'vitest'
import { stripTerminalSelectionGutter } from './terminal-selection-gutter'

// Agent CLIs paint a marker then a fixed gutter; users copy the message body.
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

  // A blank Windows CRLF row must not look like zero-indent content and cancel gutter removal.
  it('still finds the gutter across a blank CRLF row', () => {
    expect(stripTerminalSelectionGutter('  first\r\n\r\n  second\r\n')).toBe(
      'first\r\n\r\nsecond\r\n'
    )
  })

  it('does not strip past a shorter line', () => {
    const uneven = ['    deep', '  shallow'].join('\n')
    expect(stripTerminalSelectionGutter(uneven)).toBe(['  deep', 'shallow'].join('\n'))
  })

  it('leaves tab-indented text alone (terminal cells never hold tabs)', () => {
    const tabbed = ['\tone', '\ttwo'].join('\n')
    expect(stripTerminalSelectionGutter(tabbed)).toBe(tabbed)
  })
})
