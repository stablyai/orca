import { afterEach, describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isDetectedAgentAvailable } from './detected-agent-availability'
import { registerAgentCatalogSettingsSource } from './agent-catalog-settings-source'

describe('isDetectedAgentAvailable', () => {
  const CUSTOM = 'custom-agent:codex:22222222-2222-4222-8222-222222222222' as TuiAgent

  afterEach(() => {
    registerAgentCatalogSettingsSource(() => null)
  })

  function registerCustom(commandOverride?: string): void {
    registerAgentCatalogSettingsSource(() => ({
      customTuiAgents: [
        {
          id: CUSTOM as `custom-agent:codex:${string}`,
          baseAgent: 'codex',
          label: 'My Codex',
          args: '',
          env: {},
          syncEnv: false,
          ...(commandOverride ? { commandOverride } : {})
        }
      ]
    }))
  }

  it('accepts a baseline-stock custom when its base harness is detected', () => {
    registerCustom()
    expect(isDetectedAgentAvailable(CUSTOM, ['codex'])).toBe(true)
  })

  it('rejects a baseline-stock custom when its base is undetected', () => {
    registerCustom()
    expect(isDetectedAgentAvailable(CUSTOM, ['claude'])).toBe(false)
  })

  it('accepts a configured-executable custom with no base detection', () => {
    registerCustom('/opt/bin/agent')
    expect(isDetectedAgentAvailable(CUSTOM, [])).toBe(true)
  })

  it('rejects a disabled custom and one whose base is disabled', () => {
    registerCustom()
    expect(isDetectedAgentAvailable(CUSTOM, ['codex'], [CUSTOM])).toBe(false)
    expect(isDetectedAgentAvailable(CUSTOM, ['codex'], ['codex'])).toBe(false)
  })

  it('rejects a custom id the catalog cannot resolve', () => {
    expect(isDetectedAgentAvailable(CUSTOM, ['codex'])).toBe(false)
  })

  it('still gates built-ins on detection', () => {
    expect(isDetectedAgentAvailable('codex', ['codex'])).toBe(true)
    expect(isDetectedAgentAvailable('codex', ['claude'])).toBe(false)
  })
})
