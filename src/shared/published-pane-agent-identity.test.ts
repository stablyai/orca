import { describe, expect, it } from 'vitest'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'

const resolve = resolvePublishedPaneAgentIdentity

describe('resolvePublishedPaneAgentIdentity', () => {
  it('publishes a manually started DeepSeek Build owner without readable process evidence', () => {
    expect(resolve({ title: '⠋ - Review Codex integration - DeepSeek Build' })).toBe('dsb')
    expect(resolve({ title: 'DeepSeek Build' })).toBe('dsb')
    expect(resolve({ title: 'Terminal', foregroundAgent: 'dsb' })).toBe('dsb')
    expect(resolve({ title: 'Review DeepSeek Build integration' })).toBeUndefined()
  })

  describe('a task title cannot name the pane', () => {
    // Recorded task titles name other agents; substring routing previously misdelivered to these panes.
    it.each([
      ['Switch Claude and Codex off the load balancer… - grok', 'grok'],
      ['Review the Claude session-history fix', 'codex'],
      ['✳ Fix the text cursor blink', 'claude']
    ])('keeps %j as its launched agent', (title, launchAgent) => {
      expect(resolve({ launchAgent: launchAgent as never, title })).toBe(launchAgent)
    })
  })

  it('keeps the launch record when an unambiguous title names a different agent', () => {
    // Unlike agreeing/absent title cases, this detects the title-first mutant: explicit Claude branding cannot override a Codex launch.
    expect(resolve({ launchAgent: 'codex', title: '✳ Claude Code' })).toBe('codex')
  })

  it('prefers the live foreground process to the launch record', () => {
    expect(resolve({ launchAgent: 'claude', foregroundAgent: 'codex' })).toBe('codex')
  })

  describe('title is the last resort, and the parser is what makes that safe', () => {
    // Strict title evidence rejects names in task prose that the old substring matcher accepted.
    it('does not name a Codex pane Claude from its task text', () => {
      expect(resolve({ title: 'Review the Claude session-history fix' })).toBeUndefined()
    })

    it('reads the owner suffix, not the agents named in the task text', () => {
      expect(resolve({ title: 'Switch Claude and Codex off the load balancer… - grok' })).toBe(
        'grok'
      )
    })

    it('identifies a pane whose title unambiguously names its agent', () => {
      // Hand-started WSL panes may lack launch/process/hooks; unambiguous title evidence keeps them addressable.
      expect(resolve({ title: '✳ Claude Code' })).toBe('claude')
    })

    it('still declines a bare worktree name that merely contains an agent word', () => {
      expect(resolve({ title: 'review-14600-codex' })).toBeUndefined()
    })

    it('lets every stronger source outrank an unambiguous title', () => {
      expect(resolve({ title: '✳ Claude Code', hookAgent: 'codex', hookIsLive: true })).toBe(
        'codex'
      )
      expect(resolve({ title: '✳ Claude Code', foregroundAgent: 'codex' })).toBe('codex')
      expect(resolve({ title: '✳ Claude Code', launchAgent: 'codex' })).toBe('codex')
    })
  })

  it('publishes nothing when the title names no agent unambiguously', () => {
    // Absence is meaningful: it tells a caller to fail closed rather than guess.
    expect(resolve({ title: '◐ Rebase PR #14624 onto main' })).toBeUndefined()
    expect(resolve({ title: 'Fix the codex bug' })).toBeUndefined()
    expect(resolve({})).toBeUndefined()
  })

  describe('identity must not depend on how the agent was started', () => {
    // Shell-started agents lack Orca launch records, so identity must also work from hooks.
    it('identifies a shell-started agent from its own hook report', () => {
      expect(resolve({ hookAgent: 'codex', hookIsLive: true })).toBe('codex')
    })

    it('identifies a shell-started agent on WSL, where the process signal is useless', () => {
      // Windows sees wsl.exe rather than the distro agent; completed hooks retain identity without launch/process evidence.
      expect(resolve({ hookAgent: 'codex', hookIsLive: false })).toBe('codex')
    })

    it('still resolves when only a launch record exists', () => {
      expect(resolve({ launchAgent: 'claude' })).toBe('claude')
    })
  })

  describe('a launch record is outranked by live observation, not by other records', () => {
    // Keep launch above completed hooks until run keys expire old evidence; both are past records and stale hooks could hijack reused panes.

    it('keeps the launch record when only a completed hook competes', () => {
      // The launch record names the current process; unstamped completed hooks may describe a previous agent (pane-agent-owner.ts).
      expect(resolve({ launchAgent: 'claude', hookAgent: 'codex', hookIsLive: false })).toBe(
        'claude'
      )
    })

    it('lets a live hook outrank a stale launch record', () => {
      expect(resolve({ launchAgent: 'claude', hookAgent: 'codex', hookIsLive: true })).toBe('codex')
    })
  })
})
