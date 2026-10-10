import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { worktree } from './worktree-list-groups-test-fixtures'
import { getWorkspaceSessionTitle } from './workspace-session-title'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: worktree.id,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('workspace session title', () => {
  it('follows the most recently focused named session, ignoring a newer unnamed shell', () => {
    const first = tab({ generatedLabel: 'Fix checkout', lastFocusedAt: 4 })
    const second = tab({ id: 'second', generatedLabel: 'Review shipping', lastFocusedAt: 3 })
    const shell = tab({ id: 'shell', label: 'zsh — /tmp', lastFocusedAt: 6 })
    expect(getWorkspaceSessionTitle(worktree, [first, second, shell], true)).toBe('Fix checkout')
    expect(
      getWorkspaceSessionTitle(worktree, [first, { ...second, lastFocusedAt: 5 }, shell], true)
    ).toBe('Review shipping')
    expect(getWorkspaceSessionTitle(worktree, [shell], true)).toBeUndefined()
  })

  it('uses creation time until focus history exists', () => {
    expect(
      getWorkspaceSessionTitle(
        worktree,
        [tab({ generatedLabel: 'Old' }), tab({ generatedLabel: 'New', createdAt: 2 })],
        true
      )
    ).toBe('New')
  })

  it('honors generated-title opt-out and still uses explicitly named or AI Vault sessions', () => {
    expect(
      getWorkspaceSessionTitle(worktree, [tab({ generatedLabel: 'Generated' })], false)
    ).toBeUndefined()
    const named = tab({ customLabel: '  My task  ', generatedLabel: 'Generated' })
    expect(getWorkspaceSessionTitle(worktree, [named], false)).toBe('My task')
    expect(
      getWorkspaceSessionTitle(
        worktree,
        [tab({ aiVaultTitle: { agent: 'codex', sessionId: 's1', title: 'Vault task' } })],
        false
      )
    ).toBe('Vault task')
  })

  it('ignores live terminal status, quick commands, and non-agent surfaces', () => {
    expect(
      getWorkspaceSessionTitle(
        worktree,
        [tab({ label: 'Working on checkout', quickCommandLabel: 'Dev server' })],
        true
      )
    ).toBeUndefined()
    expect(
      getWorkspaceSessionTitle(
        worktree,
        [tab({ contentType: 'editor', customLabel: 'app.ts' })],
        true
      )
    ).toBeUndefined()
    expect(
      getWorkspaceSessionTitle(
        worktree,
        [tab({ contentType: 'agent-session', generatedLabel: 'Refactor checkout' })],
        true
      )
    ).toBe('Refactor checkout')
  })

  it('keeps titles isolated by workspace and execution host', () => {
    const local = { ...worktree, hostId: 'local' as const }
    const remote = { ...worktree, hostId: 'ssh:build' as const }
    const tabs = [
      tab({ executionHostId: 'local', generatedLabel: 'Local task' }),
      tab({ executionHostId: 'ssh:build', generatedLabel: 'Remote task', createdAt: 2 })
    ]
    expect(getWorkspaceSessionTitle(local, tabs, true, true)).toBe('Local task')
    expect(getWorkspaceSessionTitle(remote, tabs, true, true)).toBe('Remote task')
    expect(
      getWorkspaceSessionTitle(
        local,
        [tab({ worktreeId: 'other', generatedLabel: 'Other task' })],
        true
      )
    ).toBeUndefined()
    expect(
      getWorkspaceSessionTitle(local, [tab({ generatedLabel: 'Unowned' })], true, true)
    ).toBeUndefined()
  })

  it('accepts the workspace paired-runtime host alias', () => {
    const remote = {
      ...worktree,
      hostId: 'ssh:build' as const,
      runtimeOwnerEnvironmentId: 'remote-1'
    }
    expect(
      getWorkspaceSessionTitle(
        remote,
        [tab({ executionHostId: 'runtime:remote-1', generatedLabel: 'Remote work' })],
        true,
        true
      )
    ).toBe('Remote work')
  })
})
