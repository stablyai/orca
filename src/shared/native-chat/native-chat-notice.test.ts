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

const frame = (kind: string): NonNullable<NativeChatTextBlock['providerFrame']> => ({
  provider: 'codex',
  kind,
  payload: { head: '{}', byteLength: 2, digest: 'synthetic', truncated: false }
})

it('collapses only provider retries and Codex configuration or deprecation notices behind a summary', () => {
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'warning',
      text: 'Claude hit a temporary problem and is retrying. Retry 2 of 10.',
      failure: {
        kind: 'providerRetrying',
        detail: { text: '{"type":"system","subtype":"api_retry"}', audience: 'log' },
        retry: { error: 'overloaded', status: 529, attempt: 2, maxRetries: 10 }
      }
    })
  ).toEqual({ kind: 'collapsed-notice', label: 'retrying', attempt: 2, maxRetries: 10 })
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'warning',
      text: 'Claude is rate limited.',
      failure: { kind: 'providerRetrying', retry: { status: 429, attempt: 1, maxRetries: 10 } }
    })
  ).toEqual({ kind: 'collapsed-notice', label: 'rate-limited', attempt: 1, maxRetries: 10 })
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'warning',
      text: 'Codex is retrying: Reconnecting... 2/5.',
      failure: {
        kind: 'providerRetrying',
        detail: { text: 'Reconnecting... 2/5', audience: 'person' }
      },
      providerFrame: frame('notification:error')
    })
  ).toEqual({ kind: 'collapsed-notice', label: 'retrying' })
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'warning',
      text: 'Unknown key in config.toml.',
      providerFrame: frame('notification:configWarning')
    })
  ).toEqual({ kind: 'collapsed-notice', label: 'configuration' })
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'notice',
      text: 'This option will be removed.',
      providerFrame: frame('notification:deprecationNotice')
    })
  ).toEqual({ kind: 'collapsed-notice', label: 'deprecation' })
  // Errors and other notifications keep the boxed line.
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'error',
      text: 'The configuration could not be read.',
      providerFrame: frame('notification:configWarning')
    })
  ).toEqual({ kind: 'line', tone: 'error' })
  expect(
    nativeChatNoticeLook({
      type: 'text',
      tone: 'warning',
      text: 'Disk is almost full.',
      providerFrame: frame('notification:warning')
    })
  ).toEqual({ kind: 'line', tone: 'warning' })
})
