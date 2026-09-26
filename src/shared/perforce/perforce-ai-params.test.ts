import { describe, expect, it } from 'vitest'
import { resolvePerforceAiParams } from './perforce-ai-params'
import { DEFAULT_PERFORCE_SETTINGS, type PerforceSettings } from './perforce-settings'

const settings = { defaultTuiAgent: 'claude' as const, agentCmdOverrides: {} }
const resolve = (patch: Partial<PerforceSettings>) =>
  resolvePerforceAiParams({ settings, perforce: { ...DEFAULT_PERFORCE_SETTINGS, ...patch } })

describe('resolvePerforceAiParams', () => {
  it('uses the app default agent when none is chosen, never Git AI settings', () => {
    const result = resolve({})
    expect(result).toMatchObject({ ok: true, params: { agentId: 'claude' } })
  })

  it('uses the Perforce agent and extra arguments', () => {
    const result = resolve({ aiAgentId: 'codex', aiAgentArgs: '--fast' })
    expect(result).toMatchObject({
      ok: true,
      params: { agentId: 'codex', agentArgs: '--fast' }
    })
  })

  it('requires a command for the custom agent', () => {
    expect(resolve({ aiAgentId: 'custom' }).ok).toBe(false)
    expect(resolve({ aiAgentId: 'custom', aiCustomCommand: 'my-cli' })).toMatchObject({
      ok: true,
      params: { agentId: 'custom', customAgentCommand: 'my-cli' }
    })
  })

  it('rejects an agent that cannot write descriptions', () => {
    expect(resolve({ aiAgentId: 'not-an-agent' }).ok).toBe(false)
  })
})
