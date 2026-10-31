import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetSessionSourceControlHistoryLayoutForTests,
  clampSourceControlHistoryHeight,
  DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT,
  getSessionSourceControlHistoryExpanded,
  getSessionSourceControlHistoryHeight,
  MAX_SOURCE_CONTROL_HISTORY_HEIGHT,
  MIN_SOURCE_CONTROL_HISTORY_HEIGHT,
  setSessionSourceControlHistoryExpanded,
  setSessionSourceControlHistoryHeight
} from './source-control-history-layout'

afterEach(() => {
  _resetSessionSourceControlHistoryLayoutForTests()
})

describe('source-control-history-layout', () => {
  it('clamps height into the closed panel range', () => {
    expect(clampSourceControlHistoryHeight(10)).toBe(MIN_SOURCE_CONTROL_HISTORY_HEIGHT)
    expect(clampSourceControlHistoryHeight(9999)).toBe(MAX_SOURCE_CONTROL_HISTORY_HEIGHT)
    expect(clampSourceControlHistoryHeight(Number.NaN)).toBe(DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT)
  })

  it('remembers expanded state and height across getters/setters', () => {
    expect(getSessionSourceControlHistoryExpanded()).toBe(false)
    setSessionSourceControlHistoryExpanded(true)
    setSessionSourceControlHistoryHeight(480)
    expect(getSessionSourceControlHistoryExpanded()).toBe(true)
    expect(getSessionSourceControlHistoryHeight()).toBe(480)
  })
})
