import { describe, expect, it } from 'vitest'
import { buildSpriteAnimationCss } from './sprite-animation-css'

const BASE = {
  keyframesId: 'kf',
  frameWidth: 100,
  scale: 1,
  rowOffsetY: -200
}

describe('buildSpriteAnimationCss', () => {
  it('emits one step-end stop per frame for uneven Codex-style pacing', () => {
    const { keyframesCss, animationCss } = buildSpriteAnimationCss({
      ...BASE,
      frames: 6,
      fps: 8,
      frameDurationsMs: [1680, 660, 660, 840, 840, 1920]
    })

    // Cumulative stops for [1680, 660, 660, 840, 840, 1920] over 6600ms.
    expect(keyframesCss).toContain('0% { background-position: 0px -200px; }')
    expect(keyframesCss).toContain('25.4545% { background-position: -100px -200px; }')
    expect(keyframesCss).toContain('70.9091% { background-position: -500px -200px; }')
    expect(keyframesCss).not.toContain(' to {')
    expect(animationCss).toBe('pet-kf 6.6s step-end infinite')
  })

  it('falls back to uniform steps() when durations are absent, invalid, or corrupt', () => {
    for (const frameDurationsMs of [
      undefined,
      [100, 100],
      [100, -1, 100],
      [100, Number.NaN, 100],
      // Above the importer's 60s cap: corrupt/hand-edited persisted holds must
      // not freeze the overlay.
      [100, 70_000, 100],
      // Untrusted persisted data: non-arrays with a matching `length` must not
      // reach .every and throw.
      { length: 3 } as unknown as number[],
      'aaa' as unknown as number[]
    ]) {
      const { keyframesCss, animationCss } = buildSpriteAnimationCss({
        ...BASE,
        frames: 3,
        fps: 6,
        frameDurationsMs
      })
      expect(keyframesCss).toBe(
        '@keyframes pet-kf { from { background-position: 0px -200px; } to { background-position: -300px -200px; } }'
      )
      expect(animationCss).toBe('pet-kf 0.5s steps(3) infinite')
    }
  })

  it('degrades to uniform pacing rather than dropping a frame that rounds away', () => {
    // A sub-precision frame among a ~minute total loses its own stop: a leading
    // one collapses two stops to 0%, a trailing one rounds the final stop to
    // 100% (no interval before the loop). Either way, degrade to steps() so
    // every frame still renders instead of letting one vanish.
    for (const frameDurationsMs of [
      [0.001, 60_000],
      [60_000, 0.001]
    ]) {
      const { keyframesCss, animationCss } = buildSpriteAnimationCss({
        ...BASE,
        frames: 2,
        fps: 8,
        frameDurationsMs
      })
      expect(keyframesCss).not.toContain('step')
      expect(keyframesCss).toContain(' to {')
      expect(animationCss).toContain('steps(2)')
    }
  })

  it('plays the row `repeat` times then loops the settle track, matching Codex', () => {
    // Codex's "running": row 7 x3 (820ms each) settling into idle's 6.6s loop.
    const { keyframesCss, animationCss } = buildSpriteAnimationCss({
      ...BASE,
      frames: 6,
      fps: 8,
      frameDurationsMs: [120, 120, 120, 120, 120, 220],
      repeat: 3,
      settle: {
        frames: 6,
        rowOffsetY: 0,
        frameDurationsMs: [1680, 660, 660, 840, 840, 1920]
      }
    })

    expect(animationCss).toBe(
      'pet-kf-burst 2.46s step-end 0s 1, pet-kf-rest 6.6s step-end 2.46s infinite'
    )
    // The burst replays the same six cells three times, so x wraps per rep.
    expect(keyframesCss).toContain('0% { background-position: 0px -200px; }')
    expect(keyframesCss).toContain('33.3333% { background-position: 0px -200px; }')
    expect(keyframesCss).toContain('66.6667% { background-position: 0px -200px; }')
    // The rest track sits on the settle row, not the burst row.
    expect(keyframesCss).toContain('@keyframes pet-kf-rest')
    expect(keyframesCss).toContain('25.4545% { background-position: -100px 0px; }')
  })

  it('fast-forwards a re-minted track by settleElapsedMs instead of replaying', () => {
    const input = {
      ...BASE,
      frames: 6,
      fps: 8,
      frameDurationsMs: [120, 120, 120, 120, 120, 220],
      repeat: 3,
      settle: {
        frames: 6,
        rowOffsetY: 0,
        frameDurationsMs: [1680, 660, 660, 840, 840, 1920]
      }
    }

    // Mid-burst: resume 1s in, rest starts after the remaining 1.46s.
    expect(buildSpriteAnimationCss({ ...input, settleElapsedMs: 1000 }).animationCss).toBe(
      'pet-kf-burst 2.46s step-end -1s 1, pet-kf-rest 6.6s step-end 1.46s infinite'
    )
    // Past the burst: it is skipped whole and the rest loop keeps its phase.
    expect(buildSpriteAnimationCss({ ...input, settleElapsedMs: 10_000 }).animationCss).toBe(
      'pet-kf-burst 2.46s step-end -2.46s 1, pet-kf-rest 6.6s step-end -7.54s infinite'
    )
  })

  it('loops the row itself when settle data is absent or unusable', () => {
    for (const extra of [
      {},
      { repeat: 3 },
      { repeat: 0, settle: { frames: 2, rowOffsetY: 0, frameDurationsMs: [100, 100] } },
      { repeat: 1.5, settle: { frames: 2, rowOffsetY: 0, frameDurationsMs: [100, 100] } },
      // Settle track whose durations fail validation must not strand the burst.
      { repeat: 3, settle: { frames: 2, rowOffsetY: 0, frameDurationsMs: undefined } },
      { repeat: 3, settle: { frames: 2, rowOffsetY: 0, frameDurationsMs: [100] } }
    ]) {
      const { animationCss } = buildSpriteAnimationCss({
        ...BASE,
        frames: 2,
        fps: 8,
        frameDurationsMs: [100, 300],
        ...extra
      })
      expect(animationCss).toBe('pet-kf 0.4s step-end infinite')
    }
  })

  it('renders a genuinely short-but-representable frame as its own stop', () => {
    const { keyframesCss } = buildSpriteAnimationCss({
      ...BASE,
      frames: 2,
      fps: 8,
      frameDurationsMs: [10, 990]
    })
    expect(keyframesCss).toContain('0% { background-position: 0px -200px; }')
    expect(keyframesCss).toContain('1% { background-position: -100px -200px; }')
  })
})
