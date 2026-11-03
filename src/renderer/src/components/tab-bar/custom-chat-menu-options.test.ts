import { describe, expect, it } from 'vitest'
import { customChatMenuOptions } from './custom-chat-menu-options'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { decodeAgentSessionAgentsResult } from '../../../../shared/agent-session/agent-session-registered-agents'

const agents = decodeAgentSessionAgentsResult({
  agents: [
    { agent: 'custom-reviewer', displayName: 'Company reviewer', capabilities: {} },
    { agent: 'codex', capabilities: {} }
  ]
})!

function options(executionHostId: string, overrides = {}) {
  return customChatMenuOptions({
    agents,
    route: {
      agent: 'claude',
      executionHostId,
      hostCapabilities: RUNTIME_CAPABILITIES,
      clientCapabilities: RUNTIME_CAPABILITIES,
      workspaceKind: 'folder',
      ...overrides
    },
    availability: new Map([
      [
        'custom-reviewer',
        { agent: 'custom-reviewer', state: 'available', chatProgram: 'available' }
      ]
    ]),
    executionHostId: 'local'
  })
}

describe('custom adapter chat entries', () => {
  it('offers named host-registered adapters without masquerading as built-ins', () => {
    expect(options('local')).toMatchObject([
      { kind: 'custom-chat', customChat: { agent: 'custom-reviewer' } }
    ])
    expect(options('local')[0]?.label).toContain('Company reviewer')
    expect(options('runtime:remote-1')).toHaveLength(1)
  })

  it('keeps unsupported hosts, WSL, outside-root launches and missing programs out of the menu', () => {
    expect(options('ssh:box')).toEqual([])
    expect(options('local', { startsOutsideWorkspaceRoot: true })).toEqual([])
    expect(
      options('local', { projectRuntime: { status: 'resolved', runtime: { kind: 'wsl' } } })
    ).toEqual([])
    expect(options('local', { hostCapabilities: [] })).toEqual([])
    expect(
      customChatMenuOptions({
        agents,
        route: {
          agent: 'claude',
          executionHostId: 'local',
          hostCapabilities: RUNTIME_CAPABILITIES
        },
        availability: new Map(),
        executionHostId: 'local'
      })
    ).toEqual([])
  })
})
