import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

describe('resolveTabAgentFromSignals', () => {
  it('uses a recognized foreground agent as the live local source of truth', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: 'codex',
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps launch intent during the pre-start shell window', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('lets shell foreground clear stale identity even when the title still names an agent', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('maps OpenClaude titles to the distinct OpenClaude tab icon', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '⠋ OpenClaude',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('openclaude')
  })

  it('keeps title fallback for real Gemini and Pi titles', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('gemini')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'π - my-project',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('pi')
  })

  it("uses completed OpenClaude hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        hasCompletedHook: true,
        completedHookAgent: 'openclaude',
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('uses Claude-owned title identity before OpenClaude launch intent when hooks have not arrived', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'openclaude'
      })
    ).toBe('claude')
  })

  it("uses Codex hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ improve-pr-actions-customization',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('keeps explicit Claude Code titles authoritative over stale OpenClaude launch intent', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'openclaude'
      })
    ).toBe('claude')
  })

  it('lets shell foreground clear the icon after an agent was observed running', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('does not let a pre-start shell sample suppress a later hook signal', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('prefers explicit hook identity over a conflicting title mention', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('prefers explicit hook identity over ordinary non-Claude title identity', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: 'claude',
        hasCompletedHook: false,
        launchAgent: 'gemini'
      })
    ).toBe('claude')
  })

  it('does not let launch intent turn Claude-owned task text into Gemini', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'gemini'
      })
    ).toBe('claude')
  })

  it('does not let launch intent turn Claude-owned task text into OpenCode', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '. Compare Opencode Vs Orca',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'opencode'
      })
    ).toBe('claude')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '* Review Codex behavior',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('treats Claude-prefixed task text as Claude before launch intent when no hook arrived', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Gemini CLI',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('claude')

    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '. Compare Opencode Vs Orca',
        hookAgent: null,
        hasCompletedHook: false,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('skips local foreground authority for remote worktrees', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: true,
        title: 'Terminal 1',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('keeps completed remote hook identity after the terminal title returns to a shell', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: true,
        completedHookAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })

  it('suppresses stale local launch intent after a completed hook and shell title', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: true,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })
})
