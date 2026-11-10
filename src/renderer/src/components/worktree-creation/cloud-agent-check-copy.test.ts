import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { cloudAgentCheckCopy } from './cloud-agent-check-copy'

const signedOut = (agent: string, name: string): EnvironmentDoctorCheck => ({
  category: 'agents',
  id: `agent.${agent}`,
  status: 'warn',
  message: `${name} is installed but not signed in.`,
  code: 'agentSignedOut',
  params: { agent: name }
})
const CLAUDE = signedOut('claude', 'Claude')

function ready(overrides: {
  state?: 'none' | 'active' | 'expired'
  provider?: 'on' | 'off' | 'disabled'
  covered?: boolean
}): Parameters<typeof cloudAgentCheckCopy>[1] {
  const provider = overrides.provider ?? 'on'
  const status: OrcaCloudAgentsStatus = {
    credentials: {
      claude: { state: overrides.state ?? 'none' },
      codex: { state: 'none' },
      providerEnabled: { claude: provider === 'on', codex: true },
      providerState: { claude: provider, codex: 'on' }
    },
    sources: { defaults: {}, coveredByKey: { claude: overrides.covered ?? false, codex: false } }
  }
  return {
    load: { kind: 'ready', status },
    keyKinds: { claude: overrides.covered ? 'team' : null, codex: null }
  }
}

const copy = (check: EnvironmentDoctorCheck, accounts: Parameters<typeof cloudAgentCheckCopy>[1]) =>
  cloudAgentCheckCopy(check, accounts, translate)

describe('cloudAgentCheckCopy', () => {
  it('hides the row when the Orca account or a key covers the agent', () => {
    expect(copy(CLAUDE, ready({ state: 'active' }))).toEqual({ kind: 'hide' })
    expect(copy(CLAUDE, ready({ covered: true }))).toEqual({ kind: 'hide' })
  })

  it('says not set up, and where to set it up, when nothing covers the agent', () => {
    expect(copy(CLAUDE, ready({}))).toEqual({
      kind: 'copy',
      message: 'Claude isn’t set up for Orca Cloud yet.',
      remediation: 'Set it up once in Settings → Agent accounts. Every cloud workspace uses it.'
    })
    expect(copy(CLAUDE, ready({ state: 'expired' }))).toMatchObject({
      message: 'Your Claude sign-in for Orca Cloud expired.'
    })
  })

  it('never says “isn’t set up” when there is nothing to set up', () => {
    const paused = copy(CLAUDE, ready({ provider: 'disabled' }))
    const notOffered = copy(CLAUDE, ready({ provider: 'off' }))
    for (const result of [paused, notOffered]) {
      expect(result?.kind).toBe('copy')
      expect(result && 'message' in result ? result.message : '').not.toMatch(/set up/)
    }
    expect(paused).toMatchObject({ remediation: expect.stringContaining('paused') })
    expect(notOffered).toMatchObject({
      remediation: expect.stringContaining('Signs in for each cloud workspace for now')
    })
  })

  it('says nothing until the account is read', () => {
    expect(
      copy(CLAUDE, { load: { kind: 'loading' }, keyKinds: { claude: null, codex: null } })
    ).toEqual({ kind: 'hide' })
  })

  it('points API-key agents at Cloud secrets, and leaves other checks to the shared copy', () => {
    expect(copy(signedOut('gemini', 'Gemini CLI'), ready({}))).toMatchObject({
      message: 'Gemini CLI isn’t signed in.',
      remediation: expect.stringContaining('Cloud secrets')
    })
    expect(copy({ ...CLAUDE, code: 'diskLow', params: { free: '2' } }, ready({}))).toBeNull()
    expect(copy({ ...CLAUDE, code: undefined }, ready({}))).toBeNull()
  })
})
