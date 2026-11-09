import { expect, it } from 'vitest'
import { nativeChatNoticeLook } from './native-chat-notice'

it.each([
  { provider: 'codex', kind: 'notification:warning' },
  { provider: 'codex', kind: 'item/autoApprovalReview/completed' },
  { provider: 'claude', kind: 'request:canUseTool' },
  { provider: 'claude', kind: 'notification:guardianWarning' }
])('does not infer settled permission state from other frame kinds (%j)', (frame) => {
  expect(
    nativeChatNoticeLook({
      type: 'text',
      text: 'Permission denied automatically',
      tone: 'error',
      providerFrame: {
        ...frame,
        payload: {
          head: '{"status":"denied"}',
          byteLength: 19,
          digest: 'synthetic',
          truncated: false
        }
      }
    })
  ).toEqual({ kind: 'line', tone: 'error' })
})

it.each([
  { failure: { kind: 'usageLimitReached' } },
  { presentation: 'orca-stop' },
  { presentation: 'plan-document' },
  { orcaStop: { cause: 'quit' } }
] as const)(
  'keeps special presentations and typed failures ahead of permission disclosure (%j)',
  (special) => {
    expect(
      nativeChatNoticeLook({
        type: 'text',
        text: 'Existing behavior',
        tone: 'error',
        ...special,
        providerFrame: {
          provider: 'codex',
          kind: 'notification:guardianWarning',
          payload: { head: '{}', byteLength: 2, digest: 'synthetic', truncated: false }
        }
      }).kind
    ).not.toBe('settled-permission')
  }
)

it('draws the forked-from row as a divider naming and linking its source', () => {
  expect(
    nativeChatNoticeLook({
      type: 'text',
      text: 'Forked from Fix the login flow',
      presentation: 'forked-from',
      forkedFrom: { sessionId: 'claude_source' }
    })
  ).toEqual({
    kind: 'forked-from',
    sourceSessionId: 'claude_source',
    sourceName: 'Fix the login flow'
  })
})
