import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { buildSidebarDefaultAgentStartup } from './sidebar-default-agent-startup'

describe('buildSidebarDefaultAgentStartup', () => {
  it('emits the remote relay CLI name for SSH repos identified only by executionHostId', () => {
    const settings = {
      ...getDefaultSettings('/tmp/.orca-workspaces'),
      defaultTuiAgent: 'claude-agent-teams' as const
    }

    const payload = buildSidebarDefaultAgentStartup(settings, {
      path: '/srv/m4air/repo',
      connectionId: null,
      executionHostId: 'ssh:m4air'
    })

    expect(payload?.command).toMatch(/^orca claude-teams/)
    expect(payload?.command).not.toContain('orca-ide')
  })
})
