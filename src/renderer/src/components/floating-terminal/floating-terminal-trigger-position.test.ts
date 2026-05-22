import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampFloatingTerminalTriggerPosition,
  getDefaultFloatingTerminalTriggerPosition,
  parseFloatingTerminalTriggerPosition
} from './floating-terminal-trigger-position'

function stubViewport(width: number, height: number): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height })
}

describe('floating terminal trigger position', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to the bottom right of the viewport', () => {
    stubViewport(1200, 800)

    expect(getDefaultFloatingTerminalTriggerPosition()).toEqual({
      left: 1144,
      top: 696
    })
  })

  it('clamps parked positions into the viewport', () => {
    stubViewport(640, 480)

    expect(clampFloatingTerminalTriggerPosition({ left: 900, top: -20 })).toEqual({
      left: 600,
      top: 36
    })
  })

  it('ignores malformed persisted positions', () => {
    stubViewport(640, 480)

    expect(parseFloatingTerminalTriggerPosition('not-json')).toBeNull()
    expect(parseFloatingTerminalTriggerPosition('{"left":"1","top":2}')).toBeNull()
  })
})
