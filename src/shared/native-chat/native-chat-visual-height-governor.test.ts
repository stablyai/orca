import { describe, expect, it } from 'vitest'
import { createNativeChatVisualHeightGovernor } from './native-chat-visual-height-governor'

describe('createNativeChatVisualHeightGovernor', () => {
  it('applies clamped changes and ignores repeats', () => {
    const governor = createNativeChatVisualHeightGovernor()
    expect(governor.decide(300, 0)).toEqual({ kind: 'apply', height: 300 })
    expect(governor.decide(300.2, 10)).toEqual({ kind: 'ignore' })
    expect(governor.decide(5, 20)).toEqual({ kind: 'apply', height: 80 })
    expect(governor.decide(50_000, 30)).toEqual({ kind: 'apply', height: 2000 })
  })

  it('defers changes past the per-second budget instead of dropping the last one', () => {
    const governor = createNativeChatVisualHeightGovernor()
    let now = 0
    for (let index = 0; index < 20; index += 1) {
      // Alternate shrinking and growing in large steps so no runaway is detected.
      expect(governor.decide(index % 2 === 0 ? 200 : 900, now).kind).toBe('apply')
      now += 10
    }
    expect(governor.decide(500, now)).toEqual({ kind: 'defer', retryInMs: 1_000 - now })
    expect(governor.decide(500, 1_000)).toEqual({ kind: 'apply', height: 500 })
  })

  it('stops growth that only follows the frame (100vh plus a margin) but still lets it shrink', () => {
    const governor = createNativeChatVisualHeightGovernor()
    let height = 200
    let now = 0
    governor.decide(height, now)
    const applied: number[] = []
    for (let index = 0; index < 30; index += 1) {
      height += 16
      now += 50
      const decision = governor.decide(height, now)
      if (decision.kind === 'apply') {
        applied.push(decision.height)
      }
    }
    expect(applied.length).toBeLessThan(12)
    const frozenAt = applied.at(-1) ?? 200
    expect(governor.decide(frozenAt + 16, now + 2_000)).toEqual({ kind: 'ignore' })
    expect(governor.decide(150, now + 3_000)).toEqual({ kind: 'apply', height: 150 })
  })

  it('lets a page grow in steps as slow images and fonts arrive', () => {
    const governor = createNativeChatVisualHeightGovernor()
    expect(governor.decide(200, 0).kind).toBe('apply')
    expect(governor.decide(240, 800).kind).toBe('apply')
    expect(governor.decide(280, 1_600).kind).toBe('apply')
    expect(governor.decide(600, 1_650).kind).toBe('apply')
  })

  it('lets an animated expansion finish, whose steps vary frame to frame', () => {
    const governor = createNativeChatVisualHeightGovernor()
    let height = 200
    let now = 0
    governor.decide(height, now)
    const steps = [3, 9, 15, 20, 24, 26, 26, 24, 20, 15, 9, 5, 3, 2]
    for (const step of steps) {
      height += step
      now += 16
      expect(governor.decide(height, now)).toEqual({ kind: 'apply', height })
    }
  })
})
