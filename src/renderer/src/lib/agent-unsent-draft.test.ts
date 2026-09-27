import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_UNSENT_DRAFT_CHECK_DELAY_MS,
  AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS,
  hasAgentUnsentDraft,
  registerAgentUnsentDraftProbe,
  resetAgentUnsentDraftsForTests,
  scheduleAgentUnsentDraftCheck,
  setAgentUnsentDraft,
  subscribeAgentUnsentDraft
} from './agent-unsent-draft'

afterEach(() => {
  resetAgentUnsentDraftsForTests()
  vi.useRealTimers()
})

describe('agent unsent draft registry', () => {
  it('notifies a pane only when its answer changes', () => {
    const listener = vi.fn()
    subscribeAgentUnsentDraft('tab-1:leaf-1', listener)

    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', true)
    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', false)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('keeps one pane flag out of another pane subscribers', () => {
    const listener = vi.fn()
    subscribeAgentUnsentDraft('tab-1:leaf-1', listener)

    setAgentUnsentDraft('tab-2:leaf-9', 'terminal', true)

    expect(listener).not.toHaveBeenCalled()
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('keeps one composer from clearing the other behind the same pane key', () => {
    const listener = vi.fn()
    subscribeAgentUnsentDraft('tab-1:leaf-1', listener)

    // A bridge pane overlays the native chat on the agent's TUI, both under this key.
    setAgentUnsentDraft('tab-1:leaf-1', 'native-chat', true)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // Typing in the TUI reports an empty composer; the native draft still waits.
    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', false)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    setAgentUnsentDraft('tab-1:leaf-1', 'native-chat', false)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('needs both composers to clear before the pane reads clean', () => {
    setAgentUnsentDraft('tab-1:leaf-1', 'native-chat', true)
    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', true)

    setAgentUnsentDraft('tab-1:leaf-1', 'terminal', false)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    setAgentUnsentDraft('tab-1:leaf-1', 'native-chat', false)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('collapses a burst of input into one probe pass', () => {
    vi.useFakeTimers()
    const probe = vi.fn(() => true)
    registerAgentUnsentDraftProbe('tab-1:leaf-1', probe)

    for (let key = 0; key < 25; key += 1) {
      scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    }
    expect(probe).not.toHaveBeenCalled()

    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    // A pass that saw text queues its own late look, and input during that window
    // rides on it instead of adding another timer.
    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS)
    expect(probe).toHaveBeenCalledTimes(2)

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('takes one late look after seeing text, so sending retires the marker', () => {
    vi.useFakeTimers()
    let composerText = 'digitando'
    registerAgentUnsentDraftProbe('tab-1:leaf-1', () => composerText !== '')

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    // Enter sends the message: the composer empties with no further input to react to.
    composerText = ''
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('stops looking once a pass finds nothing waiting', () => {
    vi.useFakeTimers()
    const probe = vi.fn(() => false)
    registerAgentUnsentDraftProbe('tab-1:leaf-1', probe)

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(
      AGENT_UNSENT_DRAFT_CHECK_DELAY_MS + AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS * 3
    )

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a pane with no probe, so a closed pane costs no timer', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    subscribeAgentUnsentDraft('tab-1:leaf-1', listener)

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS * 4)

    expect(listener).not.toHaveBeenCalled()
  })

  it('leaves the last known answer alone when the pane cannot read itself', () => {
    vi.useFakeTimers()
    let answer: boolean | null = true
    registerAgentUnsentDraftProbe('tab-1:leaf-1', () => answer)

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    // A hibernated or detached pane answers null; the text is still in its composer.
    answer = null
    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)
  })

  it('stops probing a pane once it unregisters', () => {
    vi.useFakeTimers()
    const probe = vi.fn(() => true)
    const unregister = registerAgentUnsentDraftProbe('tab-1:leaf-1', probe)

    scheduleAgentUnsentDraftCheck('tab-1:leaf-1')
    unregister()
    vi.advanceTimersByTime(AGENT_UNSENT_DRAFT_CHECK_DELAY_MS * 2)

    expect(probe).not.toHaveBeenCalled()
  })
})
