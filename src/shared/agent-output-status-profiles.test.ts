import { describe, expect, it, vi } from 'vitest'
import { createAgentOutputStatusObserver } from './agent-output-status-profiles'

const BOB_IDLE = '  ❯   Build Anything, @ for context, / for commands, $ for skills\n'
const BOB_SPINNER = ' ❯ fix it\n ⠋ Processing… (Enter to steer, Tab to queue)\n'
const CC_BANNER = '# Command Code v0.27.3\n'
const CC_WORKING = '❯ fix it\n✻ Thinking...\n'

describe('createAgentOutputStatusObserver', () => {
  it('routes each profile to its own agent id', () => {
    const onWorking = vi.fn()
    const observer = createAgentOutputStatusObserver({ onWorking })
    observer.observe(BOB_IDLE)
    expect(observer.observe(BOB_SPINNER)).toBe(true)
    expect(onWorking).toHaveBeenLastCalledWith('bob', 'fix it')
    observer.observe(CC_BANNER)
    expect(observer.observe(CC_WORKING)).toBe(true)
    expect(onWorking).toHaveBeenLastCalledWith('command-code', 'fix it')
  })

  it('keeps feeding every detector after one profile fires', () => {
    // Why: a detector that missed chunks would lose its rolling window and miss
    // a banner or status split across the seam.
    const onWorking = vi.fn()
    const observer = createAgentOutputStatusObserver({ onWorking })
    observer.observe(BOB_IDLE)
    observer.observe(`${BOB_SPINNER}# Command Code v0.2`)
    expect(observer.observe('7.3\n')).toBe(false)
    expect(observer.observe(CC_WORKING)).toBe(true)
    expect(onWorking).toHaveBeenLastCalledWith('command-code', 'fix it')
  })

  it('seeds each profile from its own in-flight turn', () => {
    const onDone = vi.fn()
    const observer = createAgentOutputStatusObserver({
      onWorking: vi.fn(),
      onDone,
      readInFlightTurn: (agent) => (agent === 'bob' ? { prompt: 'resume me' } : null)
    })
    expect(observer.observe(BOB_IDLE)).toBe(true)
    expect(onDone).toHaveBeenCalledWith('bob', 'resume me')
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
