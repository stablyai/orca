import { describe, expect, it } from 'vitest'
import { deriveCloudAgentReadiness } from './cloud-agent-readiness'

describe('deriveCloudAgentReadiness', () => {
  it('prefers an every-host desktop key, then a team key, then the user’s own secret', () => {
    expect(
      deriveCloudAgentReadiness(
        [{ agent: 'claude', hostScope: { kind: 'all' } }],
        [{ name: 'OPENAI_API_KEY', scope: 'org' }]
      )
    ).toEqual({ claude: 'desktop-key', codex: 'team' })
    expect(
      deriveCloudAgentReadiness([], [{ name: 'AI_GATEWAY_API_KEY', scope: 'personal' }])
    ).toEqual({ claude: 'cloud-secret', codex: 'cloud-secret' })
  })

  it('ignores host-scoped desktop keys and variables that are not credentials', () => {
    expect(
      deriveCloudAgentReadiness(
        [{ agent: 'codex', hostScope: { kind: 'hosts', hostIds: ['ssh:devbox'] } }],
        [
          { name: 'ANTHROPIC_MODEL', scope: 'org' },
          { name: 'DATABASE_URL', scope: 'repo' }
        ]
      )
    ).toEqual({ claude: null, codex: null })
  })
})
