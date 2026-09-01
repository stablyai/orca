import { describe, expect, it } from 'vitest'
import type { TuiAgentConfig } from '../../../shared/tui-agent-config'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'

function makeConfig(overrides: Partial<TuiAgentConfig> = {}): TuiAgentConfig {
  return { ...({} as TuiAgentConfig), ...overrides }
}

describe('agentDeliversDraftViaNativePrefill', () => {
  it('reports native delivery when the resolved base config has a draft prefill flag', () => {
    expect(agentDeliversDraftViaNativePrefill(makeConfig({ draftPromptFlag: '--prefill' }), false)).toBe(
      true
    )
    expect(
      agentDeliversDraftViaNativePrefill(makeConfig({ draftPromptEnvVar: 'DRAFT_PROMPT' }), undefined)
    ).toBe(true)
  })

  it('reports no native delivery for a base without a prefill mechanism', () => {
    expect(agentDeliversDraftViaNativePrefill(makeConfig(), false)).toBe(false)
  })

  // Registry safety (oracle 16): an unresolvable custom id resolves to a null
  // config upstream; the helper must degrade to "not native" rather than crash.
  it('degrades to a paste path when the resolved config is null (unknown/custom id)', () => {
    expect(agentDeliversDraftViaNativePrefill(null, false)).toBe(false)
  })

  it('never claims native delivery when the caller forces a paste', () => {
    expect(
      agentDeliversDraftViaNativePrefill(makeConfig({ draftPromptFlag: '--prefill' }), true)
    ).toBe(false)
  })
})
