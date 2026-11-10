import { describe, expect, it } from 'vitest'
import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import { deriveCloudAgentReadiness, offerableDesktopKeys } from './cloud-agent-readiness'

describe('deriveCloudAgentReadiness', () => {
  it('prefers a team key, then the user’s own secret; this computer’s keys never count', () => {
    expect(deriveCloudAgentReadiness([{ name: 'OPENAI_API_KEY', scope: 'org' }])).toEqual({
      claude: null,
      codex: 'team'
    })
    expect(deriveCloudAgentReadiness([{ name: 'AI_GATEWAY_API_KEY', scope: 'personal' }])).toEqual({
      claude: 'cloud-secret',
      codex: 'cloud-secret'
    })
  })

  it('ignores variables that are not credentials', () => {
    expect(
      deriveCloudAgentReadiness([
        { name: 'ANTHROPIC_MODEL', scope: 'org' },
        { name: 'DATABASE_URL', scope: 'repo' }
      ])
    ).toEqual({ claude: null, codex: null })
  })
})

describe('offerableDesktopKeys', () => {
  const key = (
    id: string,
    agent: 'claude' | 'gemini' | 'cursor',
    envName: string,
    all = true
  ): Pick<AgentApiKeySummary, 'id' | 'agent' | 'envName' | 'hint' | 'hostScope'> => ({
    id,
    agent,
    envName,
    hint: id.slice(-4),
    hostScope: all ? { kind: 'all' } : { kind: 'hosts', hostIds: ['ssh:devbox'] }
  })

  it('offers every-host keys whose variable no Cloud secret sets, once per variable', () => {
    expect(
      offerableDesktopKeys(
        [
          key('k-0001', 'claude', 'ANTHROPIC_API_KEY'),
          key('k-0002', 'gemini', 'GEMINI_API_KEY'),
          key('k-0003', 'cursor', 'CURSOR_API_KEY', false),
          key('k-0004', 'claude', 'GEMINI_API_KEY')
        ],
        [{ name: 'ANTHROPIC_API_KEY' }]
      )
    ).toEqual([{ id: 'k-0002', agent: 'gemini', envName: 'GEMINI_API_KEY', hint: '0002' }])
  })
})

describe('offerableDesktopKeys: only keys a workspace gets as a stand-in', () => {
  it('never offers a key the proxy cannot swap (it would sit on the VM in full)', () => {
    const all = { kind: 'all' } as const
    expect(
      offerableDesktopKeys(
        [
          {
            id: 'a',
            agent: 'claude',
            envName: 'AWS_BEARER_TOKEN_BEDROCK',
            hint: 'aaaa',
            hostScope: all
          },
          {
            id: 'b',
            agent: 'opencode',
            envName: 'OPENROUTER_API_KEY',
            hint: 'bbbb',
            hostScope: all
          },
          { id: 'c', agent: 'cursor', envName: 'CURSOR_API_KEY', hint: 'cccc', hostScope: all }
        ],
        []
      ).map((key) => key.envName)
    ).toEqual(['CURSOR_API_KEY'])
  })
})
