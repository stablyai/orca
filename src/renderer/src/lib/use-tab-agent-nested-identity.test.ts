import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

// Why (#13341): nested Claude↔Codex (or other cross-group) invocations become the
// local foreground process / title while the parent session still owns the pane.
// Durable launch ownership must keep the parent icon until the parent exits.
describe('resolveTabAgentFromSignals — nested child identity (#13341)', () => {
  it('keeps active Codex launch ownership when a nested Claude identity title appears', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('lets a Claude identity title own the icon once launch ownership has cleared', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps OpenCode launch ownership when a nested Claude identity title appears', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'opencode'
      })
    ).toBe('opencode')
  })

  it('keeps Claude launch ownership when a nested Codex process is foreground', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Codex',
        hookAgent: null,
        processAgent: 'codex',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('keeps Codex launch ownership when a nested Claude process is foreground', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        processAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps parent ownership when fenced parent hooks coexist with nested process', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Codex',
        hookAgent: 'claude',
        processAgent: 'codex',
        launchAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: 'codex',
        processAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('still lets a nested process identity surface once launch ownership has exited', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        processAgent: 'codex',
        launchAgent: undefined
      })
    ).toBe('codex')
  })

  it('treats shell-foreground as exit so a later process can own the icon', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        processAgent: null,
        processShellForeground: true,
        launchAgent: 'claude'
      })
    ).toBeNull()
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Codex',
        hookAgent: null,
        processAgent: 'codex',
        processShellForeground: false,
        launchAgent: undefined
      })
    ).toBe('codex')
  })

  it('keeps remote parent ownership when only a nested child title is visible', () => {
    // Remote panes lack local process evidence; nested title alone must not rebrand.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '✦ Codex',
        hookAgent: null,
        processAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('lets a live different-group hook outrank launch (explicit takeover)', () => {
    // Why: hooks are ground truth; fenced nested hooks keep parent agentType upstream.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Codex',
        hookAgent: 'codex',
        processAgent: 'codex',
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  // Why (#8478): native OC| reclaim must stay OpenCode after observation and under launch.
  it('keeps OpenCode OC| reclaim after process observation under a non-OpenCode launch', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'OC | Greeting',
        hookAgent: null,
        processAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('opencode')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'OC | Greeting',
        hookAgent: null,
        processAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('opencode')
  })

  it('still fences nested Codex title under Claude launch (not OC|)', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Codex',
        hookAgent: null,
        processAgent: 'codex',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('clears OpenCode reclaim on shell return so launch can exit', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        processAgent: null,
        processShellForeground: true,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })
})
