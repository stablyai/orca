import { describe, expect, it } from 'vitest'
import { stripNativeAgentTeamsEnv } from './claude-agent-teams-environment'

describe('Claude Agent Teams environment', () => {
  it('removes Windows native authority using case-insensitive key and path identity', () => {
    const stripped = stripNativeAgentTeamsEnv(
      {
        tMuX: '/tmp/orca/stale,0,1',
        Tmux_Pane: '%1',
        OrCa_AgEnT_TeAmS_TeAm_Id: 'stale-team',
        orca_agent_teams_token: 'stale-token',
        orca_agent_teams_shim_dir: 'c:\\stale-shim',
        pAtH: '"C:/STALE-SHIM/";C:\\Windows\\System32',
        CLAUDE_PROFILE: 'preserved'
      },
      'win32'
    )

    expect(stripped).toEqual({
      pAtH: 'C:\\Windows\\System32',
      CLAUDE_PROFILE: 'preserved'
    })
  })

  it('removes every shim authority after a mixed-version environment merge', () => {
    const inherited = {
      orca_agent_teams_shim_dir: 'C:\\old-shim',
      Path: 'C:\\old-shim;C:\\Windows\\System32'
    }
    const legacyResponse = {
      ORCA_AGENT_TEAMS_SHIM_DIR: 'C:\\new-shim',
      PATH: 'C:\\new-shim;C:\\old-shim;C:\\Windows\\System32'
    }

    expect(stripNativeAgentTeamsEnv({ ...inherited, ...legacyResponse }, 'win32')).toEqual({
      Path: 'C:\\Windows\\System32',
      PATH: 'C:\\Windows\\System32'
    })
  })
})
