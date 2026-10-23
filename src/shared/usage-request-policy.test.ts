import { describe, expect, it } from 'vitest'
import {
  composeUsageRequestPolicyEnabled,
  mergeUsageRequestEnabled,
  normalizeUsageRequestEnabled
} from './usage-request-policy'

describe('normalizeUsageRequestEnabled', () => {
  it('keeps explicit choices sparse and rejects truthy values and unsupported providers', () => {
    expect(
      normalizeUsageRequestEnabled({
        claude: false,
        codex: true,
        gemini: 'false',
        kimi: 0,
        minimax: null,
        grok: undefined,
        cursor: [],
        zcode: {},
        antigravity: false,
        futureProvider: false
      })
    ).toEqual({ claude: false, codex: true })
  })

  it('preserves an opt-out for every controllable provider', () => {
    const disabled = {
      claude: false,
      codex: false,
      gemini: false,
      'opencode-go': false,
      kimi: false,
      minimax: false,
      grok: false,
      cursor: false,
      zcode: false
    }
    expect(normalizeUsageRequestEnabled(disabled)).toEqual(disabled)
  })

  it.each([undefined, null, false, 0, 'false', [{ claude: false }]])(
    'treats a non-map value as no explicit choice: %j',
    (input) => expect(normalizeUsageRequestEnabled(input)).toEqual({})
  )

  it('does not persist inherited choices from a non-JSON object', () => {
    const input = Object.assign(Object.create({ claude: false }), { codex: false })
    expect(normalizeUsageRequestEnabled(input)).toEqual({ codex: false })
  })
})

describe('mergeUsageRequestEnabled', () => {
  it('keeps unrelated opt-outs while allowing explicit re-enablement', () => {
    const current = Object.freeze({ claude: false, codex: false })
    const updates = Object.freeze({ codex: true, gemini: false })
    expect(mergeUsageRequestEnabled(current, updates)).toEqual({
      claude: false,
      codex: true,
      gemini: false
    })
    expect(current).toEqual({ claude: false, codex: false })
    expect(updates).toEqual({ codex: true, gemini: false })
  })

  it('ignores malformed updates without erasing valid stored opt-outs', () => {
    expect(
      mergeUsageRequestEnabled(
        { claude: false, codex: false, kimi: 'false', unknown: false },
        { claude: 'true', codex: null, antigravity: false, unknown: true }
      )
    ).toEqual({ claude: false, codex: false })
    expect(mergeUsageRequestEnabled({ claude: false }, null)).toEqual({ claude: false })
    expect(mergeUsageRequestEnabled(null, { codex: false })).toEqual({ codex: false })
  })
})

describe('composeUsageRequestPolicyEnabled', () => {
  it('enables omitted providers and takes Antigravity only from its separate control', () => {
    expect(
      composeUsageRequestPolicyEnabled(
        { claude: false, codex: 'false', gemini: true, antigravity: true, unknown: false },
        false
      )
    ).toEqual({
      claude: false,
      codex: true,
      gemini: true,
      'opencode-go': true,
      kimi: true,
      minimax: true,
      grok: true,
      antigravity: false,
      cursor: true,
      zcode: true
    })
    expect(composeUsageRequestPolicyEnabled({ antigravity: false }, true).antigravity).toBe(true)
  })

  it('keeps legacy profiles without a policy enabled', () => {
    const composed = composeUsageRequestPolicyEnabled(undefined, true)
    expect(Object.values(composed)).toHaveLength(10)
    expect(Object.values(composed).every((enabled) => enabled === true)).toBe(true)
  })
})
