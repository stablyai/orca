import { expect, it } from 'vitest'
import { nativeChatNoticeLook } from './native-chat-notice'
import type { NativeChatTextBlock } from './native-chat-types'

function guardianReview(text: string): NativeChatTextBlock {
  return {
    type: 'text',
    text,
    tone: 'warning',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:guardianWarning',
      payload: { head: '{}', byteLength: 2, digest: 'synthetic', truncated: false }
    }
  }
}

it('reads only approved Codex automatic reviews as neutral notices', () => {
  expect(
    nativeChatNoticeLook(
      guardianReview(
        'Automatic approval review approved (risk: medium, authorization: high): Read-only status query.'
      )
    )
  ).toEqual({ kind: 'settled-permission', decision: 'approved', agent: 'Codex', tone: 'notice' })
  for (const text of [
    'Automatic approval review denied (risk: high, authorization: low): Outside scope.',
    'Automatic approval review timed out while evaluating the requested approval.'
  ]) {
    expect(nativeChatNoticeLook(guardianReview(text))).toEqual({
      kind: 'settled-permission',
      decision: 'safety-review',
      agent: 'Codex',
      tone: 'warning'
    })
  }
})
