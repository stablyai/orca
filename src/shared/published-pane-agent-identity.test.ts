import { describe, expect, it } from 'vitest'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'

const resolve = resolvePublishedPaneAgentIdentity

describe('resolvePublishedPaneAgentIdentity', () => {
  describe('a task title cannot name the pane', () => {
    // Minimized from real recorded titles. Each is a pane of one agent whose task text names
    // another; before this, `@<other>` routing delivered to them.
    it.each([
      ['Switch Claude and Codex off the load balancer… - grok', 'grok'],
      ['Review the Claude session-history fix', 'codex'],
      ['✳ Fix the text cursor blink', 'claude']
    ])('keeps %j as its launched agent', (title, launchAgent) => {
      expect(resolve({ launchAgent: launchAgent as never, title })).toBe(launchAgent)
    })
  })

  it('keeps the launch record when an unambiguous title names a different agent', () => {
    // The ranking assertion. Every other case here either yields no title evidence or agrees with
    // the launch record, so without this one the suite passes even with title ranked FIRST —
    // verified by mutation. `✳ Claude Code` is a parseable, unambiguous Claude title, and it still
    // must not rename a pane Orca launched as Codex.
    expect(resolve({ launchAgent: 'codex', title: '✳ Claude Code' })).toBe('codex')
  })

  it('prefers the live foreground process to the launch record', () => {
    // The pane was launched as Claude and the user then started Codex in it. The process is the
    // more direct observation, so it wins.
    expect(resolve({ launchAgent: 'claude', foregroundAgent: 'codex' })).toBe('codex')
  })

  describe('title is the last resort, and the parser is what makes that safe', () => {
    // The misdelivery this PR exists to stop, re-checked with title ALLOWED at the bottom. The old
    // code matched `buildAgentNameRe('claude').test(title)`; the parser is categorically stricter
    // and yields nothing for a name that only appears in task text.
    it('does not name a Codex pane Claude from its task text', () => {
      expect(resolve({ title: 'Review the Claude session-history fix' })).toBeUndefined()
    })

    it('reads the owner suffix, not the agents named in the task text', () => {
      expect(resolve({ title: 'Switch Claude and Codex off the load balancer… - grok' })).toBe(
        'grok'
      )
    })

    it('identifies a pane whose title unambiguously names its agent', () => {
      // The WSL case: no launch record, no readable foreground process, no hooks installed. An
      // unambiguous title is the only thing left, and refusing it made the pane unaddressable.
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

  it('publishes nothing for a hyphenated worktree name that contains an agent word', () => {
    expect(resolve({ title: 'review-14600-codex' })).toBeUndefined()
  })

  describe('identity must not depend on how the agent was started', () => {
    // Most agents are started by typing `claude` / `codex` at a shell, not through Orca's agent
    // launcher. Those panes have no launch record at all, so anything that leans on one works for
    // roughly half of real usage.
    it('identifies a shell-started agent from its own hook report', () => {
      expect(resolve({ hookAgent: 'codex', hookIsLive: true })).toBe('codex')
    })

    it('identifies a shell-started agent on WSL, where the process signal is useless', () => {
      // The Windows host reads the foreground process of a WSL pane as `wsl.exe`, not the agent
      // running inside the distro — so `foregroundAgent` cannot name it and there is no launch
      // record. Without hook evidence this pane is unaddressable.
      expect(resolve({ hookAgent: 'codex', hookIsLive: false })).toBe('codex')
    })

    it('still resolves when only a launch record exists', () => {
      expect(resolve({ launchAgent: 'claude' })).toBe('claude')
    })
  })

  describe('a launch record is outranked by live observation, not by other records', () => {
    // NOTE: `launch` deliberately still ranks ABOVE `completed-hook`, matching
    // pane-agent-owner.ts. Demoting it looked right — a launch record is past tense — but a
    // completed hook is past tense too, and without run keys it never expires. Ranking it higher
    // lets a stale hook from a previous agent hijack a pane from the fresh launch record of the
    // agent running now. The reorder belongs with run generation, not before it.

    // Field report: launch an agent, close it, reuse the terminal — the pane kept reading as the
    // old agent. A launch record does not stop being true when the thing it describes ends.
    it('keeps the launch record when only a completed hook competes', () => {
      // Both are records, and neither expires without run keys. The launch record is the one Orca
      // stamped for the CURRENT process, so promoting the hook above it lets a stale hook from a
      // previous agent hijack the pane. Matches pane-agent-owner.ts.
      expect(resolve({ launchAgent: 'claude', hookAgent: 'codex', hookIsLive: false })).toBe(
        'claude'
      )
    })

    it('lets a live hook outrank a stale launch record', () => {
      expect(resolve({ launchAgent: 'claude', hookAgent: 'codex', hookIsLive: true })).toBe('codex')
    })

    it('lets the live foreground process outrank a stale launch record', () => {
      expect(resolve({ launchAgent: 'claude', foregroundAgent: 'codex' })).toBe('codex')
    })
  })
})
