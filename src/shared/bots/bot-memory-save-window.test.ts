import { describe, expect, it } from 'vitest'
import {
  BOT_MEMORY_SAVE_ATTEMPTED,
  botMemorySaveReading,
  botMemorySaveStep,
  botMemorySaveThresholds,
  type BotMemorySaveReading
} from './bot-memory-save-window'

const reading = (
  usedTokens: number,
  windowTokens: number | null = 200_000,
  autoCompactAtTokens: number | null = null
): BotMemorySaveReading => ({ usedTokens, windowTokens, autoCompactAtTokens })

describe('botMemorySaveThresholds', () => {
  it('saves at 75% of the window when the harness compacts later or not at all', () => {
    expect(botMemorySaveThresholds(reading(0, 200_000))).toEqual({
      saveAt: 150_000,
      rearmAt: 130_000
    })
    expect(botMemorySaveThresholds(reading(0, 1_000_000, 967_000)).saveAt).toBe(750_000)
  })

  it('saves before an earlier harness compaction point, keeping the larger reserve', () => {
    // 200k window: reserve max(20k, 10k) = 20k below a 160k compaction point.
    expect(botMemorySaveThresholds(reading(0, 200_000, 160_000))).toEqual({
      saveAt: 140_000,
      rearmAt: 120_000
    })
    // 1M window: reserve max(20k, 50k) = 50k below a 700k compaction point.
    expect(botMemorySaveThresholds(reading(0, 1_000_000, 700_000)).saveAt).toBe(650_000)
  })

  it('uses 150k/130k when the window is unknown', () => {
    expect(botMemorySaveThresholds(reading(0, null))).toEqual({ saveAt: 150_000, rearmAt: 130_000 })
  })
})

describe('botMemorySaveStep', () => {
  const armed = { armed: true }

  it('is due once usage reaches the save point in an armed window', () => {
    expect(botMemorySaveStep(armed, reading(149_999)).due).toBe(false)
    expect(botMemorySaveStep(armed, reading(150_000)).due).toBe(true)
  })

  it('stays used after an attempt until a measured drop to rearmAt, then fires again', () => {
    let state = BOT_MEMORY_SAVE_ATTEMPTED
    // Still high, or a shallow drop: no second save.
    for (const used of [190_000, 160_000, 140_000, 131_000, 160_000]) {
      const step = botMemorySaveStep(state, reading(used))
      expect(step.due).toBe(false)
      expect(step.state).toBe(state)
      state = step.state
    }
    // Compaction freed enough: re-armed, but not due until it fills again.
    const dropped = botMemorySaveStep(state, reading(40_000))
    expect(dropped.state).toEqual({ armed: true })
    expect(dropped.due).toBe(false)
    expect(botMemorySaveStep(dropped.state, reading(150_000)).due).toBe(true)
  })

  it('returns the same state object when nothing changes', () => {
    expect(botMemorySaveStep(armed, reading(10_000)).state).toBe(armed)
  })
})

describe('botMemorySaveReading', () => {
  it('reads a report with its compaction point and an estimate with its window', () => {
    expect(
      botMemorySaveReading({
        used: {
          kind: 'report',
          model: 'm',
          usedTokens: 120_000,
          windowTokens: 200_000,
          percentage: 60,
          autoCompactAtTokens: 180_000,
          categories: [],
          capturedAt: 1
        }
      })
    ).toEqual({ usedTokens: 120_000, windowTokens: 200_000, autoCompactAtTokens: 180_000 })
    expect(
      botMemorySaveReading({
        used: {
          kind: 'estimate',
          usage: {
            inputTokens: 10,
            cacheCreationInputTokens: 20,
            cacheReadInputTokens: 70,
            outputTokens: 999
          },
          capturedAt: 1
        }
      })
    ).toEqual({ usedTokens: 100, windowTokens: null, autoCompactAtTokens: null })
  })

  it('is null when nothing is measured', () => {
    expect(botMemorySaveReading({})).toBeNull()
    expect(botMemorySaveReading({ used: { kind: 'unknown', capturedAt: 1 } })).toBeNull()
  })
})
