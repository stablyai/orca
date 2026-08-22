import { describe, expect, it, vi } from 'vitest'
import { createBobOutputStatusDetector } from './bob-output-status'

// Why: fragments below are byte-stripped frames captured from Bob Shell 2.0.1.
const IDLE_COMPOSER =
  ' ──────────────────────\n  ❯   Build Anything, @ for context, / for commands, $ for skills\n ──────────────────────\n  Agent Mode (auto-approve)\n'
const SPINNER_FRAME = '\n ⠋ Processing… (Enter to steer, Tab to queue)\n\n ──────────────────────\n'
const PROMPT_ECHO = ' ❯ Run the shell command then reply with exactly: FINISHED\n'
const APPROVAL =
  '  Execute Command\n  Command:          echo perm-probe\n  Approve commands:\n  ┌────┐\n  │echo│\n  └────┘\n  → Approve Once\n    Always Allow Command for task\n    Reject\n\n  Press Enter to confirm\n'

function detector(
  args: { startupCommand?: string | null; inFlightTurn?: { prompt: string } | null } = {}
) {
  const onWorking = vi.fn()
  const onDone = vi.fn()
  const onWaiting = vi.fn()
  const instance = createBobOutputStatusDetector({ ...args, onWorking, onDone, onWaiting })
  return { instance, onWorking, onDone, onWaiting }
}

describe('createBobOutputStatusDetector', () => {
  it('arms on the Bob composer, then reports working with the submitted prompt', () => {
    const { instance, onWorking } = detector()
    expect(instance.observe(IDLE_COMPOSER)).toBe(false)
    expect(instance.observe(PROMPT_ECHO + SPINNER_FRAME)).toBe(true)
    expect(onWorking).toHaveBeenCalledWith(
      'Run the shell command then reply with exactly: FINISHED'
    )
  })

  it('does not trust a bare spinner before any Bob UI was seen', () => {
    // Why: the steer hint is Bob-only and arms the scrape; a plain spinner could be any app.
    const { instance, onWorking } = detector()
    expect(instance.observe('\n ⠋ Processing…\n')).toBe(false)
    expect(onWorking).not.toHaveBeenCalled()
  })

  it('arms from the bob launch command', () => {
    const { instance, onWorking } = detector({ startupCommand: 'bob chat --trust' })
    expect(instance.observe('\x1b[32m ⠙ Processing…\x1b[0m (Enter to steer, Tab to queue)\n')).toBe(
      true
    )
    expect(onWorking).toHaveBeenCalledWith('')
  })

  it('does not arm from the Neovim version manager launch line', () => {
    const { instance } = detector({ startupCommand: 'bob use stable' })
    expect(instance.observe('\n ⠋ Processing…\n')).toBe(false)
  })

  it('reports done when the idle composer returns after a prompt', () => {
    const { instance, onDone } = detector()
    instance.observe(IDLE_COMPOSER)
    instance.observe(PROMPT_ECHO + SPINNER_FRAME)
    expect(instance.observe(`• FINISHED\n${IDLE_COMPOSER}`)).toBe(true)
    expect(onDone).toHaveBeenCalledWith('Run the shell command then reply with exactly: FINISHED')
  })

  it('never captures the idle composer placeholder as a prompt', () => {
    const { instance, onDone } = detector()
    instance.observe(IDLE_COMPOSER)
    expect(instance.observe(IDLE_COMPOSER)).toBe(false)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('reports waiting on an approval prompt and working again once approved', () => {
    const { instance, onWaiting, onWorking } = detector()
    instance.observe(IDLE_COMPOSER)
    instance.observe(PROMPT_ECHO + SPINNER_FRAME)
    expect(instance.observe(APPROVAL)).toBe(true)
    expect(onWaiting).toHaveBeenCalledWith(
      'Run the shell command then reply with exactly: FINISHED'
    )
    expect(instance.observe(SPINNER_FRAME)).toBe(true)
    expect(onWorking).toHaveBeenLastCalledWith(
      'Run the shell command then reply with exactly: FINISHED'
    )
  })

  it('reports waiting on a skill approval prompt', () => {
    const { instance, onWaiting } = detector({ inFlightTurn: { prompt: 'use the docs skill' } })
    expect(instance.observe('  Allow Bob to use this skill\n  → Approve Once\n')).toBe(true)
    expect(onWaiting).toHaveBeenCalledWith('use the docs skill')
  })

  it('seeds from an in-flight turn so a parked pane can settle to done', () => {
    const { instance, onDone } = detector({ inFlightTurn: { prompt: 'fix the tests' } })
    expect(instance.observe(IDLE_COMPOSER)).toBe(true)
    expect(onDone).toHaveBeenCalledWith('fix the tests')
  })

  it('detects a spinner split across chunks', () => {
    const { instance, onWorking } = detector({ startupCommand: 'bob chat' })
    expect(instance.observe('\n ⠹ Proc')).toBe(false)
    expect(instance.observe('essing… (Enter to steer, Tab to queue)\n')).toBe(true)
    expect(onWorking).toHaveBeenCalledTimes(1)
  })

  it('does not re-fire working on carried-over text', () => {
    const { instance, onWorking } = detector({ startupCommand: 'bob chat' })
    instance.observe(SPINNER_FRAME)
    expect(instance.observe('  Agent Mode (auto-approve) · 10.3k / 270.0k (4%)\n')).toBe(false)
    expect(onWorking).toHaveBeenCalledTimes(1)
  })
})
