import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES,
  parseAgentDefaultEnvDraft,
  stringifyAgentDefaultEnvDraft
} from './agent-default-env-draft'

afterEach(() => {
  vi.restoreAllMocks()
})

function getRegexWhitespaceSplitCalls(split: ReturnType<typeof vi.spyOn>): unknown[][] {
  return split.mock.calls.filter(
    ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
  )
}

describe('agent default environment draft', () => {
  it('stringifies environment entries in the settings draft format', () => {
    expect(stringifyAgentDefaultEnvDraft({ FOO: 'bar', BAZ: 'qux' })).toBe('FOO=bar BAZ=qux')
  })

  it('tokenizes pasted environment whitespace without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const draft = ['FOO=bar', String.fromCharCode(160), 'BAZ=qux\nSKIP\tTOKEN=value=kept'].join('')

    expect(parseAgentDefaultEnvDraft(draft)).toEqual({
      env: { FOO: 'bar', BAZ: 'qux', TOKEN: 'value=kept' },
      tooLarge: false
    })
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })

  it('rejects oversized pasted environment drafts before tokenization', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const draft = 'SECRET=value '.repeat(AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES)

    expect(parseAgentDefaultEnvDraft(draft)).toEqual({ env: {}, tooLarge: true })
    expect(getRegexWhitespaceSplitCalls(split)).toHaveLength(0)
  })
})
