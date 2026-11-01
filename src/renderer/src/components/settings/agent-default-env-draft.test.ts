import { describe, expect, it } from 'vitest'
import {
  AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES,
  parseAgentDefaultEnvDraft,
  stringifyAgentDefaultEnvDraft
} from './agent-default-env-draft'

describe('agent default environment draft', () => {
  it('parses back every value it formats', () => {
    const env = {
      SPACED: 'two words',
      APOSTROPHE: "it's",
      DOUBLE: 'say "hi"',
      BOTH: `it's "x"`,
      EQUALS: 'a=b',
      EMPTY: '',
      WIN_PATH: 'C:\\Program Files\\tool',
      TAB: 'a\tb',
      PLAIN: 'keep'
    }

    expect(parseAgentDefaultEnvDraft(stringifyAgentDefaultEnvDraft(env))).toEqual({
      env,
      invalidReason: null
    })
  })

  it('keeps backslashes typed without quotes', () => {
    expect(parseAgentDefaultEnvDraft('TOOL=C:\\tools\\bin').env).toEqual({
      TOOL: 'C:\\tools\\bin'
    })
  })

  it('rejects a draft with an unclosed quote', () => {
    expect(parseAgentDefaultEnvDraft('A="two words B=keep')).toEqual({
      env: {},
      invalidReason: 'unclosed-quote'
    })
  })

  it('splits pasted entries on any whitespace and skips words without a name', () => {
    const draft = ['FOO=bar', String.fromCharCode(160), 'BAZ=qux\nSKIP\tTOKEN=value=kept'].join('')

    expect(parseAgentDefaultEnvDraft(draft)).toEqual({
      env: { FOO: 'bar', BAZ: 'qux', TOKEN: 'value=kept' },
      invalidReason: null
    })
  })

  it('rejects oversized pasted environment drafts', () => {
    const draft = 'SECRET=value '.repeat(AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES)

    expect(parseAgentDefaultEnvDraft(draft)).toEqual({ env: {}, invalidReason: 'too-large' })
  })
})
