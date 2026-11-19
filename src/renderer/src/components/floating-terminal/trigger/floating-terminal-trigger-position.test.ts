import { expect, it } from 'vitest'
import { keepFloatingTerminalTriggerClear } from './floating-terminal-trigger-position'

const card = { left: 300, top: 400, right: 700, bottom: 600, paneBottom: 700 }

it('leaves the floating terminal button where it is when it covers nothing', () => {
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 300 }, [card])).toEqual({
    left: 640,
    top: 300
  })
  expect(keepFloatingTerminalTriggerClear({ left: 200, top: 500 }, [card])).toEqual({
    left: 200,
    top: 500
  })
})

it('puts the button just below a box it would cover while the pane has room there', () => {
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 580 }, [card])).toEqual({
    left: 640,
    top: 608
  })
  expect(
    keepFloatingTerminalTriggerClear({ left: 640, top: 580 }, [{ ...card, paneBottom: 651 }])
  ).toEqual({ left: 640, top: 356 })
})

it('keeps moving until the button clears every box, not just the first it covered', () => {
  const lower = { left: 300, top: 210, right: 700, bottom: 280, paneBottom: 768 }
  const upper = { left: 300, top: 100, right: 700, bottom: 200, paneBottom: 768 }
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 150 }, [lower, upper])).toEqual({
    left: 640,
    top: 288
  })
})
