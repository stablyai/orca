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

  it('keeps a title-identified agent visible over a stale shell foreground sample', () => {
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
    ).toBe('claude')
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

  it("uses completed OpenClaude hook identity over Claude's generic task-title heuristic", () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: null,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: true,
        isRemote: false,
        title: '✳ Say hi',
        hookAgent: null,
        hasCompletedHook: true,
        completedHookAgent: 'openclaude',
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it("uses OpenClaude launch intent over Claude's generic task-title heuristic before hooks arrive", () => {
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
    ).toBe('openclaude')
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

  it('falls back to title, hook, and launch intent when foreground is inconclusive', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: false,
        shellForegroundAfterAgentSignal: false,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: 'codex',
        hasCompletedHook: false,
        launchAgent: 'gemini'
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

  it('suppresses stale launch intent after a completed hook and shell title', () => {
    expect(
      resolveTabAgentFromSignals({
        foreground: undefined,
        hasObservedAgentSignal: true,
        shellForegroundAfterAgentSignal: false,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        hasCompletedHook: true,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })
})
