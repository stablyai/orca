import { describe, expect, it } from 'vitest'
import { resolveDraftPasteReadyTimeoutMs } from './draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { CustomTuiAgent } from './tui-agent'

const CODEX_CUSTOM_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as const

const codexCustomAgent: CustomTuiAgent = {
  id: CODEX_CUSTOM_ID,
  baseAgent: 'codex',
  label: 'Codex Prod',
  args: '',
  env: {},
  syncEnv: false
}

describe('resolveDraftPasteReadyTimeoutMs', () => {
  it('uses the built-in agent budget', () => {
    expect(TUI_AGENT_CONFIG.codex.draftPasteReadyTimeoutMs).toBe(20_000)
    expect(resolveDraftPasteReadyTimeoutMs('codex')).toBe(20_000)
  })

  it('prefers an explicit override', () => {
    expect(resolveDraftPasteReadyTimeoutMs('codex', 1234)).toBe(1234)
  })

  it('resolves a custom id to its base harness budget through the catalog', () => {
    expect(resolveDraftPasteReadyTimeoutMs(CODEX_CUSTOM_ID, undefined, [codexCustomAgent])).toBe(
      20_000
    )
  })

  it('falls back to the default budget for a custom id with no catalog instead of crashing', () => {
    expect(resolveDraftPasteReadyTimeoutMs(CODEX_CUSTOM_ID)).toBe(8000)
  })

  it('falls back to the default budget for an unknown custom id', () => {
    expect(
      resolveDraftPasteReadyTimeoutMs(
        'custom-agent:codex:99999999-9999-4999-8999-999999999999',
        undefined,
        [codexCustomAgent]
      )
    ).toBe(8000)
  })
})
