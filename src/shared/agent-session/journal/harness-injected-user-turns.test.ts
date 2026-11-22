import { describe, expect, it } from 'vitest'

import {
  isKnownHarnessInjectedUserTurnText,
  stripKnownHarnessEnvelope
} from './harness-injected-user-turns'

describe('stripKnownHarnessEnvelope', () => {
  it('drops an incomplete known wrapper without a trusted user-prompt boundary', () => {
    expect(stripKnownHarnessEnvelope('<hook_result>injected hook metadata')).toBe('')
  })

  it('strips a mixed-case tag recognized by the classifier', () => {
    expect(isKnownHarnessInjectedUserTurnText('<HOOK_RESULT>injected hook metadata')).toBe(true)
    expect(
      stripKnownHarnessEnvelope(
        '<HOOK_RESULT hook_event="UserPromptSubmit">{}</HOOK_RESULT>\nFix CI config'
      )
    ).toBe('Fix CI config')
  })

  it('strips the whole wrapper when its content nests the same tag name', () => {
    expect(
      stripKnownHarnessEnvelope(
        '<hook_result>captured output: <hook_result>inner</hook_result> tail</hook_result>Fix CI config'
      )
    ).toBe('Fix CI config')
  })

  it('does not count a self-closing nested tag as another opening', () => {
    expect(
      stripKnownHarnessEnvelope('<hook_result><hook_result /></hook_result>\nFix CI config')
    ).toBe('Fix CI config')
  })

  it('strips attributed source channels while preserving bare and unknown user XML', () => {
    expect(
      stripKnownHarnessEnvelope(
        '<channel source="general">new post</channel>\nExplain the compile error'
      )
    ).toBe('Explain the compile error')
    expect(stripKnownHarnessEnvelope('<channel>general</channel> explain this feed element')).toBe(
      '<channel>general</channel> explain this feed element'
    )
    expect(stripKnownHarnessEnvelope('<user_query>fix the bug</user_query>')).toBe(
      '<user_query>fix the bug</user_query>'
    )
  })
})
