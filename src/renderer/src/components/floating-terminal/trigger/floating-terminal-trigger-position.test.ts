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

it('moves the button to a spot that clears every box, not just the one it covered', () => {
  const lower = { left: 300, top: 210, right: 700, bottom: 280, paneBottom: 768 }
  const upper = { left: 300, top: 100, right: 700, bottom: 200, paneBottom: 768 }
  // Below the upper box would land on the lower one, so the button goes above the upper box.
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 150 }, [lower, upper])).toEqual({
    left: 640,
    top: 56
  })
})

it('puts the button above a box when the room below is past the bottom of the window', () => {
  // The pane runs below the window, 800px tall here.
  const box = { left: 300, top: 400, right: 700, bottom: 760, paneBottom: 900 }
  expect(keepFloatingTerminalTriggerClear({ left: 640, top: 600 }, [box])).toEqual({
    left: 640,
    top: 356
  })
})

it('skips a spot past the window, which clamping would push back onto a box', () => {
  // The window is 800px tall here; the small box sits below it.
  const covered = { left: 300, top: 600, right: 700, bottom: 770, paneBottom: 800 }
  const offscreen = { left: 0, top: 840, right: 100, bottom: 860, paneBottom: 900 }
  const higher = { left: 300, top: 500, right: 700, bottom: 590, paneBottom: 768 }
  expect(
    keepFloatingTerminalTriggerClear({ left: 640, top: 680 }, [covered, offscreen, higher])
  ).toEqual({ left: 640, top: 456 })
})
