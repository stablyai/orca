import { describe, expect, it } from 'vitest'
import {
  getUnreportableLiveHookAgents,
  isWorktreeAgentStatusUnverifiable,
  localHookConfigOwnsWorktree,
  type WorktreeAgentObservabilityInput
} from './agent-status-observability'

function input(
  overrides: Partial<WorktreeAgentObservabilityInput> = {}
): WorktreeAgentObservabilityInput {
  return {
    liveAgents: ['claude'],
    installStateByTarget: { claude: 'not_installed' },
    connectionId: null,
    worktreePath: '/home/user/repo',
    hasActiveHookEvidence: false,
    ...overrides
  }
}

describe('localHookConfigOwnsWorktree', () => {
  it('owns a local repo', () => {
    expect(localHookConfigOwnsWorktree(null, '/home/user/repo')).toBe(true)
  })

  it('declines an SSH repo — hooks live on the remote host', () => {
    expect(localHookConfigOwnsWorktree('ssh-target-1', '/home/user/repo')).toBe(false)
  })

  it('declines an unhydrated repo rather than assuming local', () => {
    expect(localHookConfigOwnsWorktree(undefined, '/home/user/repo')).toBe(false)
  })

  it('declines a WSL worktree — hooks live inside the distro', () => {
    expect(localHookConfigOwnsWorktree(null, '\\\\wsl$\\Ubuntu\\home\\user\\repo')).toBe(false)
    expect(localHookConfigOwnsWorktree(null, '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo')).toBe(
      false
    )
  })
})

describe('getUnreportableLiveHookAgents', () => {
  it('reports a hook-target agent whose hooks were removed', () => {
    expect(getUnreportableLiveHookAgents(input())).toEqual(['claude'])
  })

  it('reports a partial install — a missing Stop hook strands the dot the same way', () => {
    expect(
      getUnreportableLiveHookAgents(input({ installStateByTarget: { claude: 'partial' } }))
    ).toEqual(['claude'])
  })

  it('reports an errored config read', () => {
    expect(
      getUnreportableLiveHookAgents(input({ installStateByTarget: { claude: 'error' } }))
    ).toEqual(['claude'])
  })

  it('stays silent when hooks are installed', () => {
    expect(
      getUnreportableLiveHookAgents(input({ installStateByTarget: { claude: 'installed' } }))
    ).toEqual([])
  })

  it('stays silent for a deliberate opt-out (skipped)', () => {
    expect(
      getUnreportableLiveHookAgents(input({ installStateByTarget: { claude: 'skipped' } }))
    ).toEqual([])
  })

  it('stays silent before the install state has been fetched', () => {
    expect(getUnreportableLiveHookAgents(input({ installStateByTarget: {} }))).toEqual([])
  })

  it('ignores agents that never had managed hooks', () => {
    // Why: opencode/pi/aider report through the title heuristic by design, so a
    // missing hook install says nothing about them.
    expect(
      getUnreportableLiveHookAgents(
        input({
          liveAgents: ['opencode', 'pi', 'aider'],
          installStateByTarget: {}
        })
      )
    ).toEqual([])
  })

  it('ignores tabs with no launch agent', () => {
    expect(getUnreportableLiveHookAgents(input({ liveAgents: [null, undefined] }))).toEqual([])
  })

  it('reports only the broken agent when a healthy one shares the worktree', () => {
    expect(
      getUnreportableLiveHookAgents(
        input({
          liveAgents: ['claude', 'codex'],
          installStateByTarget: { claude: 'not_installed', codex: 'installed' }
        })
      )
    ).toEqual(['claude'])
  })

  it('dedupes repeated agents across panes', () => {
    expect(
      getUnreportableLiveHookAgents(input({ liveAgents: ['claude', 'claude', 'claude'] }))
    ).toEqual(['claude'])
  })

  it('declines to judge an SSH worktree from the local config', () => {
    expect(getUnreportableLiveHookAgents(input({ connectionId: 'ssh-target-1' }))).toEqual([])
  })

  it('declines to judge a WSL worktree from the local config', () => {
    expect(
      getUnreportableLiveHookAgents(input({ worktreePath: '\\\\wsl$\\Ubuntu\\home\\user\\repo' }))
    ).toEqual([])
  })
})

describe('isWorktreeAgentStatusUnverifiable', () => {
  it('is true when a live hook agent cannot report', () => {
    expect(isWorktreeAgentStatusUnverifiable(input())).toBe(true)
  })

  it('is false when a pane is reporting right now', () => {
    // Why: live evidence proves the pipeline works; a stale install read must
    // never override a hook row that just arrived.
    expect(isWorktreeAgentStatusUnverifiable(input({ hasActiveHookEvidence: true }))).toBe(false)
  })

  it('is false with no live agents at all', () => {
    expect(isWorktreeAgentStatusUnverifiable(input({ liveAgents: [] }))).toBe(false)
  })
})
