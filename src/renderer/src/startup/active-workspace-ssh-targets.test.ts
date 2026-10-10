import { describe, expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { collectActiveWorkspaceSshTargetIds } from './active-workspace-ssh-targets'

function tab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'repo-a::/w/a',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as TerminalTab
}

const emptyInput = {
  activeWorktreeId: null as string | null,
  tabsByWorktree: {} as Record<string, TerminalTab[]>,
  pendingReconnectPtyIdByTabId: {} as Record<string, string>,
  terminalLayoutsByTabId: {} as Record<string, { ptyIdsByLeafId?: Record<string, string | null> }>,
  repos: [] as { id: string; connectionId?: string | null }[]
}

describe('collectActiveWorkspaceSshTargetIds', () => {
  it('returns nothing when no workspace is active', () => {
    expect(collectActiveWorkspaceSshTargetIds(emptyInput)).toEqual([])
  })

  it('returns nothing for a purely local active workspace', () => {
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-a::/w/a',
        tabsByWorktree: { 'repo-a::/w/a': [tab('t1', 'local-pty-1')] },
        repos: [{ id: 'repo-a', connectionId: null }]
      })
    ).toEqual([])
  })

  it('names the target from the active workspace repo connection', () => {
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-remote::/srv/w',
        repos: [{ id: 'repo-remote', connectionId: 'ssh-1' }]
      })
    ).toEqual(['ssh-1'])
  })

  it('names the target from a restored PTY id when the repo catalog has no connection', () => {
    // SSH worktrees are absent from worktreesByRepo at cold start; the PTY id is the durable name.
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-a::/w/a',
        tabsByWorktree: { 'repo-a::/w/a': [tab('t1')] },
        pendingReconnectPtyIdByTabId: { t1: toAppSshPtyId('ssh-2', 'pty-9') },
        repos: [{ id: 'repo-a' }]
      })
    ).toEqual(['ssh-2'])
  })

  it('names split-leaf targets on the active workspace', () => {
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-a::/w/a',
        tabsByWorktree: { 'repo-a::/w/a': [tab('t1')] },
        terminalLayoutsByTabId: {
          t1: {
            ptyIdsByLeafId: {
              leaf1: toAppSshPtyId('ssh-3', 'pty-1'),
              leaf2: null,
              leaf3: 'local-pty-2'
            }
          }
        },
        repos: [{ id: 'repo-a' }]
      })
    ).toEqual(['ssh-3'])
  })

  it('ignores targets that only own an inactive workspace', () => {
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-a::/w/a',
        tabsByWorktree: {
          'repo-a::/w/a': [tab('t1', 'local-pty-1')],
          'repo-b::/w/b': [tab('t2', toAppSshPtyId('ssh-other', 'pty-1'))]
        },
        repos: [{ id: 'repo-a' }, { id: 'repo-b', connectionId: 'ssh-other' }]
      })
    ).toEqual([])
  })

  it('deduplicates a target named by both the repo and its PTY ids', () => {
    expect(
      collectActiveWorkspaceSshTargetIds({
        ...emptyInput,
        activeWorktreeId: 'repo-remote::/srv/w',
        tabsByWorktree: {
          'repo-remote::/srv/w': [tab('t1', toAppSshPtyId('ssh-1', 'pty-1'))]
        },
        repos: [{ id: 'repo-remote', connectionId: 'ssh-1' }]
      })
    ).toEqual(['ssh-1'])
  })
})
