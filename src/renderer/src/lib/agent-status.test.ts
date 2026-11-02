import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusTracker } from './agent-status'

describe('createAgentStatusTracker', () => {
  // Claude Code v2.1.86 emits task descriptions; only ✳ identifies idle in this captured sequence.
  it('fires on Claude Code working → idle (real captured titles)', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('✳ Claude Code')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠂ Claude Code')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠐ Claude Code')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠐ User acknowledgment and confirmation')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠂ User acknowledgment and confirmation')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('✳ User acknowledgment and confirmation')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  // Cursor’s bare native title between synthesized frames must not trigger idle before done.
  it('fires on Cursor working → idle across native "Cursor Agent" re-emissions', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠋ Cursor Agent')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('Cursor Agent')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('Cursor Agent')
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('Cursor ready')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('does not fire when Factory Droid reports needs input during a working turn', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠋ Droid')
    tracker.handleTitle('Factory Droid needs input')
    expect(onBecameIdle).not.toHaveBeenCalled()
  })

  it('fires on each working → idle cycle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Fix login bug')
    tracker.handleTitle('✳ Fix login bug')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)

    tracker.handleTitle('⠐ Refactor auth module')
    tracker.handleTitle('✳ Refactor auth module')
    expect(onBecameIdle).toHaveBeenCalledTimes(2)
  })

  it('ignores non-agent titles without losing working state', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Claude Code')
    tracker.handleTitle('bash')
    tracker.handleTitle('✳ Some task description')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  // Why: reset() clears the working latch so a late/reattach idle title can't fire a phantom notification after teardown.
  it('reset() clears working state so a subsequent idle does not fire onBecameIdle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Claude Code')
    tracker.reset()
    tracker.handleTitle('✳ Claude Code')
    expect(onBecameIdle).not.toHaveBeenCalled()
  })
})
