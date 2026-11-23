import { describe, expect, it } from 'vitest'
import { agentProviderSessionsEqual } from './agent-provider-session-equality'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'

describe('agentProviderSessionsEqual hermes stores', () => {
  const session = (overrides: Partial<AgentProviderSessionMetadata>): AgentProviderSessionMetadata => ({
    key: 'session_id',
    id: 'abc-123',
    ...overrides
  })

  it('separates history rows that share one id across profile stores', () => {
    const work = session({ transcriptPath: '/h/.hermes/profiles/work/state.db#abc-123' })
    const side = session({ transcriptPath: '/h/.hermes/profiles/side/state.db#abc-123' })
    expect(agentProviderSessionsEqual('hermes', work, side)).toBe(false)
    expect(agentProviderSessionsEqual('hermes', work, session(work))).toBe(true)
  })

  it('matches a live profile session with its own history row', () => {
    const live = session({ hermesProfile: 'work' })
    const row = session({ transcriptPath: 'C:\\h\\.hermes\\profiles\\work\\state.db#abc-123' })
    expect(agentProviderSessionsEqual('hermes', live, row)).toBe(true)
  })

  it('keeps the unnamed root store one session, named stores apart from it', () => {
    const liveDefault = session({})
    const rootRow = session({ transcriptPath: '/h/.hermes/state.db#abc-123' })
    expect(agentProviderSessionsEqual('hermes', liveDefault, rootRow)).toBe(true)
    expect(
      agentProviderSessionsEqual(
        'hermes',
        liveDefault,
        session({ transcriptPath: '/h/.hermes/profiles/work/state.db#abc-123' })
      )
    ).toBe(false)
    expect(
      agentProviderSessionsEqual('hermes', liveDefault, session({ hermesProfile: 'work' }))
    ).toBe(false)
  })

  it('compares other agents by id alone, as before', () => {
    expect(
      agentProviderSessionsEqual(
        'claude',
        session({ transcriptPath: '/h/.hermes/profiles/work/state.db#abc-123' }),
        session({})
      )
    ).toBe(true)
  })
})
