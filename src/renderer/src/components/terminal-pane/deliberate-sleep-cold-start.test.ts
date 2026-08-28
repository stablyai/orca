import { describe, expect, it } from 'vitest'
import { shouldStayColdForDeliberateSleep } from './deliberate-sleep-cold-start'

const SLEPT = 'repo-1::/work/slept'
const OTHER = 'repo-1::/work/other'

function args(overrides: Partial<Parameters<typeof shouldStayColdForDeliberateSleep>[0]> = {}) {
  return {
    hasQueuedStartup: false,
    isPaneVisible: false,
    hasSleepIntent: true,
    activeWorktreeId: OTHER,
    worktreeId: SLEPT,
    ...overrides
  }
}

describe('shouldStayColdForDeliberateSleep', () => {
  it('keeps a slept workspace cold when an unrelated workspace is activated', () => {
    // The #10205 defect: this spawn is what flipped the slept workspace back to awake.
    expect(shouldStayColdForDeliberateSleep(args())).toBe(true)
  })

  it('keeps a slept workspace cold when nothing is active', () => {
    // Sleeping the focused workspace sets activeWorktreeId to null first.
    expect(shouldStayColdForDeliberateSleep(args({ activeWorktreeId: null }))).toBe(true)
  })

  it('allows the spawn once the slept workspace is itself activated', () => {
    expect(shouldStayColdForDeliberateSleep(args({ activeWorktreeId: SLEPT }))).toBe(false)
  })

  it('allows the spawn for a visible pane', () => {
    expect(shouldStayColdForDeliberateSleep(args({ isPaneVisible: true }))).toBe(false)
  })

  it('allows the spawn when a startup command targets the pane', () => {
    // Covers the agent-resume and background-launch paths, which queue a startup.
    expect(shouldStayColdForDeliberateSleep(args({ hasQueuedStartup: true }))).toBe(false)
  })

  it('does not interfere with a workspace that was never slept', () => {
    // A hidden tab that simply has no PTY yet must still be able to spawn.
    expect(shouldStayColdForDeliberateSleep(args({ hasSleepIntent: false }))).toBe(false)
  })

  it('allows the spawn after an explicit wake clears the intent', () => {
    expect(
      shouldStayColdForDeliberateSleep(args({ hasSleepIntent: false, activeWorktreeId: OTHER }))
    ).toBe(false)
  })
})
