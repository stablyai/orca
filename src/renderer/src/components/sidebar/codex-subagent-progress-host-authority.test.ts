import { describe, expect, it } from 'vitest'
import {
  resolveCodexSubagentProgressHostAuthority,
  selectCodexSubagentProgressHostAuthority,
  type CodexSubagentProgressHostAuthorityState
} from './codex-subagent-progress-host-authority'

const PARENT_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function state(
  overrides: Partial<CodexSubagentProgressHostAuthorityState> = {}
): CodexSubagentProgressHostAuthorityState {
  return {
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function select(
  overrides: Partial<CodexSubagentProgressHostAuthorityState>,
  worktreeId: string,
  tabPtyId: string
) {
  return selectCodexSubagentProgressHostAuthority(state(overrides), {
    worktreeId,
    parentPaneKey: PARENT_PANE_KEY,
    tabPtyId,
    connectionId: null
  })
}

describe('Codex subagent progress host authority', () => {
  it('keeps a legacy-local worktree on its concrete local PTY despite a focused runtime', () => {
    expect(
      select(
        {
          repos: [{ id: 'repo', connectionId: null, executionHostId: null }],
          settings: { activeRuntimeEnvironmentId: 'focused-env' },
          worktreesByRepo: { repo: [{ id: 'repo::wt-local', repoId: 'repo' }] }
        },
        'repo::wt-local',
        'local-pty-1'
      )
    ).toEqual({ kind: 'local' })
  })

  it('captures a null-stamped Model-B owner from explicit worktree authority', () => {
    expect(
      select(
        {
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }],
          worktreesByRepo: { repo: [{ id: 'repo::wt-runtime', repoId: 'repo' }] }
        },
        'repo::wt-runtime',
        'remote:env-1@@terminal-1'
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
  })

  it('uses the pane PTY instead of a stale tab-level fallback', () => {
    expect(
      selectCodexSubagentProgressHostAuthority(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }],
          worktreesByRepo: { repo: [{ id: 'repo::wt-runtime', repoId: 'repo' }] },
          terminalLayoutsByTabId: {
            'tab-1': {
              root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
              activeLeafId: '11111111-1111-4111-8111-111111111111',
              expandedLeafId: null,
              ptyIdsByLeafId: {
                '11111111-1111-4111-8111-111111111111': 'remote:env-1@@terminal-1'
              }
            }
          }
        }),
        {
          worktreeId: 'repo::wt-runtime',
          parentPaneKey: PARENT_PANE_KEY,
          tabPtyId: 'local-stale-pty',
          connectionId: null
        }
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
  })

  it('preserves local and runtime folder workspace ownership', () => {
    const folderState = {
      folderWorkspaces: [
        {
          id: 'local-folder',
          projectGroupId: 'local-group',
          connectionId: null,
          executionHostId: 'local' as const
        },
        {
          id: 'runtime-folder',
          projectGroupId: 'runtime-group',
          connectionId: null,
          executionHostId: 'runtime:env-2' as const
        }
      ],
      projectGroups: [
        { id: 'local-group', connectionId: null, executionHostId: 'local' as const },
        {
          id: 'runtime-group',
          connectionId: null,
          executionHostId: 'runtime:env-2' as const
        }
      ]
    }
    expect(select(folderState, 'folder:local-folder', 'local-folder-pty')).toEqual({
      kind: 'local'
    })
    expect(select(folderState, 'folder:runtime-folder', 'remote:env-2@@folder-terminal')).toEqual({
      kind: 'runtime',
      environmentId: 'env-2'
    })
  })

  it('fails closed for legacy SSH, unknown status ownership, and conflicting runtime evidence', () => {
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: 'ssh-target-1',
        explicitRuntimeEnvironmentId: 'unrelated-runtime',
        ptyId: 'remote:unrelated-runtime@@terminal-1'
      })
    ).toEqual({ kind: 'legacy-ssh' })
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: undefined,
        explicitRuntimeEnvironmentId: 'unrelated-runtime',
        ptyId: 'local-pty-1'
      })
    ).toEqual({ kind: 'unknown', reason: 'unknown-owner' })
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: null,
        explicitRuntimeEnvironmentId: 'env-1',
        ptyId: 'remote:env-2@@terminal-1'
      })
    ).toEqual({ kind: 'unknown', reason: 'unknown-owner' })
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: null,
        explicitRuntimeEnvironmentId: 'env-1',
        ptyId: 'stale-local-pty'
      })
    ).toEqual({ kind: 'unknown', reason: 'unknown-owner' })
  })

  it('accepts a runtime-owned SSH PTY only with its matching explicit runtime owner', () => {
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: 'runtime-ssh-target-1',
        explicitRuntimeEnvironmentId: 'env-1',
        ptyId: 'ssh:runtime-ssh-target-1@@relay-pty-1'
      })
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: 'runtime-ssh-target-1',
        explicitRuntimeEnvironmentId: null,
        ptyId: 'ssh:runtime-ssh-target-1@@relay-pty-1'
      })
    ).toEqual({ kind: 'unknown', reason: 'runtime-owner-missing' })
  })

  it('does not infer local ownership after runtime evidence disappears', () => {
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: 'runtime-ssh-target-1',
        explicitRuntimeEnvironmentId: null,
        ptyId: null
      })
    ).toEqual({ kind: 'unknown', reason: 'runtime-owner-missing' })
    expect(
      resolveCodexSubagentProgressHostAuthority({
        connectionId: null,
        explicitRuntimeEnvironmentId: null,
        ptyId: null
      })
    ).toEqual({ kind: 'unknown', reason: 'unknown-owner' })
  })
})
