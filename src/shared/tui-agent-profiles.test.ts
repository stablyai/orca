import { describe, expect, it } from 'vitest'
import {
  interpolateTuiAgentProfileVariables,
  normalizeTuiAgentProfiles,
  resolveTuiAgentBaseAgent
} from './tui-agent-profiles'

describe('tui agent profiles', () => {
  it('normalizes valid profiles and drops duplicate names', () => {
    expect(
      normalizeTuiAgentProfiles([
        {
          id: 'agent-profile:claude-work',
          baseAgent: 'claude',
          label: '  Claude   Work  ',
          cmdOverride: ' claude ',
          defaultArgs: ' --plugin-dir {worktreePath} ',
          defaultEnv: { ORCA_PLUGIN_DIR: '{worktreePath}/plugins', EMPTY: 12 }
        },
        {
          id: 'agent-profile:codex-work',
          baseAgent: 'codex',
          label: 'claude work'
        },
        {
          id: 'bad',
          baseAgent: 'claude',
          label: 'Bad'
        }
      ])
    ).toEqual([
      {
        id: 'agent-profile:claude-work',
        baseAgent: 'claude',
        label: 'Claude Work',
        cmdOverride: 'claude',
        defaultArgs: '--plugin-dir {worktreePath}',
        defaultEnv: { ORCA_PLUGIN_DIR: '{worktreePath}/plugins' }
      }
    ])
  })

  it('resolves profile ids to their base agents', () => {
    expect(
      resolveTuiAgentBaseAgent('agent-profile:claude-work', [
        { id: 'agent-profile:claude-work', baseAgent: 'claude', label: 'Claude Work' }
      ])
    ).toBe('claude')
  })

  it('interpolates repo and worktree path variables', () => {
    expect(
      interpolateTuiAgentProfileVariables('--repo {repoPath} --worktree {worktreePath}', {
        repoPath: '/repo/main',
        worktreePath: '/repo/worktree'
      })
    ).toBe('--repo /repo/main --worktree /repo/worktree')
  })
})
