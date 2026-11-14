import { describe, expect, it } from 'vitest'
import {
  computeResyncBackoffDelay,
  RESYNC_ALERT_THRESHOLD,
  RESYNC_RETRY_BASE_MS,
  RESYNC_RETRY_MAX_MS
} from './AgentTerminalPreview'

describe('AgentTerminalPreview exponential backoff', () => {
  it('computes exponential backoff delays with cap at 2000ms', () => {
    expect(computeResyncBackoffDelay(1)).toBe(150)
    expect(computeResyncBackoffDelay(2)).toBe(300)
    expect(computeResyncBackoffDelay(3)).toBe(600)
    expect(computeResyncBackoffDelay(4)).toBe(1200)
    expect(computeResyncBackoffDelay(5)).toBe(2000)
    expect(computeResyncBackoffDelay(6)).toBe(2000)
    expect(computeResyncBackoffDelay(10)).toBe(2000)
  })

  it('has base 150ms and max 2000ms constants', () => {
    expect(RESYNC_RETRY_BASE_MS).toBe(150)
    expect(RESYNC_RETRY_MAX_MS).toBe(2000)
    expect(RESYNC_ALERT_THRESHOLD).toBe(10)
  })
})
