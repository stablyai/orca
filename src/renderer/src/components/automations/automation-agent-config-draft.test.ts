import { describe, expect, it } from 'vitest'
import { agentConfigToDraftFields, draftToAgentConfig } from './automation-agent-config-draft'

describe('draftToAgentConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(draftToAgentConfig({ agentModel: '', agentLaunchArgs: '  ', agentEnv: [] })).toBeNull()
  })

  it('builds a config from non-empty fields and drops blank env keys', () => {
    expect(
      draftToAgentConfig({
        agentModel: 'opus',
        agentLaunchArgs: '--verbose',
        agentEnv: [
          { id: 'a', key: 'A', value: '1' },
          { id: 'b', key: '  ', value: 'skip' }
        ]
      })
    ).toEqual({ launchArgs: '--verbose', model: 'opus', env: { A: '1' } })
  })
})

describe('agentConfigToDraftFields', () => {
  it('expands a config back into draft fields', () => {
    const fields = agentConfigToDraftFields({ model: 'sonnet', env: { A: '1' } })
    expect(fields.agentModel).toBe('sonnet')
    expect(fields.agentLaunchArgs).toBe('')
    expect(fields.agentEnv).toHaveLength(1)
    expect(fields.agentEnv[0]).toMatchObject({ key: 'A', value: '1' })
    expect(typeof fields.agentEnv[0].id).toBe('string')
  })

  it('returns empty fields for a null config', () => {
    expect(agentConfigToDraftFields(null)).toEqual({
      agentModel: '',
      agentLaunchArgs: '',
      agentEnv: []
    })
  })

  it('round-trips through draftToAgentConfig', () => {
    const config = { launchArgs: '--x', model: 'opus', env: { K: 'v' } }
    expect(draftToAgentConfig(agentConfigToDraftFields(config))).toEqual(config)
  })
})
