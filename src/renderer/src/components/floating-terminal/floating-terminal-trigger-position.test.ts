import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampFloatingTerminalTriggerPosition,
  getDefaultFloatingTerminalTriggerPosition,
  hasUsableFloatingTerminalTriggerViewport,
  parseFloatingTerminalTriggerPosition,
  resolveFloatingTerminalTriggerPosition,
  shouldReconcileFloatingTerminalTriggerPosition
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

  it('re-anchors default positions when startup viewport dimensions change', () => {
    stubViewport(0, 0)
    const initialPosition = getDefaultFloatingTerminalTriggerPosition()

    stubViewport(1200, 800)

    expect(resolveFloatingTerminalTriggerPosition(initialPosition, 'default')).toEqual({
      left: 1144,
      top: 696
    })
  })

  it('clamps user-placed positions instead of re-anchoring them on resize', () => {
    stubViewport(1200, 800)

    expect(resolveFloatingTerminalTriggerPosition({ left: 900, top: 500 }, 'user')).toEqual({
      left: 900,
      top: 500
    })
  })

  it('ignores malformed persisted positions', () => {
    stubViewport(640, 480)

    expect(parseFloatingTerminalTriggerPosition('not-json')).toBeNull()
    expect(parseFloatingTerminalTriggerPosition('{"left":"1","top":2}')).toBeNull()
  })

  it('does not clamp parsed positions before the viewport is settled', () => {
    stubViewport(0, 0)

    expect(parseFloatingTerminalTriggerPosition('{"left":900,"top":500}')).toEqual({
      left: 900,
      top: 500
    })
  })

  it('detects whether the viewport is usable for persisted user-position clamps', () => {
    stubViewport(0, 0)
    expect(hasUsableFloatingTerminalTriggerViewport()).toBe(false)

    stubViewport(1200, 800)
    expect(hasUsableFloatingTerminalTriggerViewport()).toBe(true)
  })

  it('defers user-position reconciliation until the viewport is usable', () => {
    stubViewport(0, 0)

    expect(shouldReconcileFloatingTerminalTriggerPosition('default')).toBe(true)
    expect(shouldReconcileFloatingTerminalTriggerPosition('user')).toBe(false)

    stubViewport(1200, 800)
    expect(shouldReconcileFloatingTerminalTriggerPosition('user')).toBe(true)
  })
})
