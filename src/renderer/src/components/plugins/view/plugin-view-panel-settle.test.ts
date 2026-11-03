// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_PANEL_MAX_SETTLE_MS,
  PLUGIN_PANEL_SHOT_FIRST_QUIET_MS,
  settlePluginPanel
} from './plugin-view-panel-settle'

function fakePanel() {
  let pending = 0
  const listeners = new Set<() => void>()
  const changed = (): void => listeners.forEach((listener) => listener())
  return {
    driver: {
      pending: () => pending,
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    start: () => {
      pending += 1
      changed()
    },
    answer: () => {
      pending -= 1
      changed()
    },
    draw: changed,
    listening: () => listeners.size
  }
}

function track(promise: Promise<void>): { done: () => boolean } {
  let done = false
  void promise.then(() => {
    done = true
  })
  return { done: () => done }
}

// Past the two painted frames (their 100ms fallbacks) that follow the wait.
const FRAMES_MS = 250

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('settlePluginPanel', () => {
  it('settles a quiet panel after the first quiet spell', async () => {
    const panel = fakePanel()
    const settled = track(settlePluginPanel(panel.driver, PLUGIN_PANEL_SHOT_FIRST_QUIET_MS))
    await vi.advanceTimersByTimeAsync(PLUGIN_PANEL_SHOT_FIRST_QUIET_MS - 1)
    expect(settled.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1 + FRAMES_MS)
    expect(settled.done()).toBe(true)
    expect(panel.listening()).toBe(0)
  })

  it("waits for the worker's answer and the tree it causes", async () => {
    const panel = fakePanel()
    panel.start()
    const settled = track(settlePluginPanel(panel.driver, PLUGIN_PANEL_SHOT_FIRST_QUIET_MS))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled.done()).toBe(false)
    panel.answer()
    await vi.advanceTimersByTimeAsync(100)
    // The answer's tree restarts the quiet spell.
    panel.draw()
    await vi.advanceTimersByTimeAsync(149)
    expect(settled.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1 + FRAMES_MS)
    expect(settled.done()).toBe(true)
  })

  it('gives up on a request that never answers at the cap', async () => {
    const panel = fakePanel()
    panel.start()
    const settled = track(settlePluginPanel(panel.driver, PLUGIN_PANEL_SHOT_FIRST_QUIET_MS))
    await vi.advanceTimersByTimeAsync(PLUGIN_PANEL_MAX_SETTLE_MS - 1)
    expect(settled.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1 + FRAMES_MS)
    expect(settled.done()).toBe(true)
    expect(panel.driver.pending()).toBe(1)
  })
})
