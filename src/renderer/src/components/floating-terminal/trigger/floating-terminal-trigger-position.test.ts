import { describe, expect, it } from 'vitest'
import { keepFloatingTerminalTriggerClear } from './floating-terminal-trigger-position'

const COMMENT_BOX = { left: 300, top: 600, right: 700, bottom: 680 }

describe('keepFloatingTerminalTriggerClear', () => {
  it('shows the button just above a box it would cover, at the same left', () => {
    expect(keepFloatingTerminalTriggerClear({ left: 640, top: 620 }, [COMMENT_BOX])).toEqual({
      left: 640,
      top: 556
    })
  })

  it('leaves the button where it is when it covers nothing', () => {
    expect(keepFloatingTerminalTriggerClear({ left: 640, top: 500 }, [COMMENT_BOX])).toEqual({
      left: 640,
      top: 500
    })
    expect(keepFloatingTerminalTriggerClear({ left: 200, top: 620 }, [COMMENT_BOX])).toEqual({
      left: 200,
      top: 620
    })
  })
})
