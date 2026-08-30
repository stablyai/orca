import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

describe('command identity tab-agent precedence', () => {
  it('ranks trusted command identity below process and above the existing lower rungs', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: true,
        launchAgent: 'claude'
      })
    ).toBe('codex')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        processAgent: 'pi',
        commandAgent: 'codex',
        commandTrusted: true,
        launchAgent: 'claude'
      })
    ).toBe('pi')
  })

  it('uses untrusted command identity only when title supplies none', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Gemini CLI',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: false
      })
    ).toBe('gemini')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: false
      })
    ).toBe('codex')
  })

  it('keeps untrusted command identity above lower-rung launch identity', () => {
    // Why: an untrusted marker is still the best identity available when the
    // title is neutral; moving it below lowerRungs would silently resurrect a
    // stale launch-agent icon.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: false,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('ranks trusted command identity above a title naming a different agent', () => {
    // Why: the headline behavior change - a verified command must beat task text
    // someone typed into the title. Reordering these two rungs must fail here.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Gemini CLI',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: true
      })
    ).toBe('codex')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Review the claude session-history fix',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: true
      })
    ).toBe('codex')
  })

  it('ranks a conflicting live focused hook above trusted command identity', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        commandAgent: 'codex',
        commandTrusted: true
      })
    ).toBe('claude')
  })

  it('ranks a live sibling identity above an idle sibling identity', () => {
    // Why: the live sibling is the current split-pane owner; the completed
    // sibling is only a fallback once no live sibling identity remains.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'codex',
        siblingCompletedHookAgent: 'claude'
      })
    ).toBe('codex')
  })
})
