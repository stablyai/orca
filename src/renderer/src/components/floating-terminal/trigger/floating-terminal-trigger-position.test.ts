import { expect, it } from 'vitest'
import { keepFloatingTerminalTriggerClear } from './floating-terminal-trigger-position'

it('leaves the floating terminal button where it is when it covers nothing', () => {
  const commentBox = { left: 300, top: 600, right: 700, bottom: 680 }
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 500 }, [commentBox])).toEqual({
    left: 640,
    top: 500
  })
  expect(keepFloatingTerminalTriggerClear({ left: 200, top: 620 }, [commentBox])).toEqual({
    left: 200,
    top: 620
  })
})
