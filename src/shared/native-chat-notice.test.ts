import { describe, expect, it } from 'vitest'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeDisclosureText,
  nativeChatNoticeLook
} from './native-chat-notice'
import type { NativeChatTextBlock } from './native-chat-types'

const block = (fields: Partial<NativeChatTextBlock>): NativeChatTextBlock => ({
  type: 'text',
  text: 'words',
  ...fields
})

describe('nativeChatNoticeLook', () => {
  it.each([
    [{ presentation: 'compaction' }, { kind: 'divider', label: 'compaction' }],
    [{ presentation: 'context-cleared' }, { kind: 'divider', label: 'contextCleared' }],
    [{ presentation: 'command-output' }, { kind: 'command-output' }],
    [
      { presentation: 'history-repaired' },
      { kind: 'host-status', presentation: 'history-repaired' }
    ],
    [{ presentation: 'plan-document' }, { kind: 'plan' }],
    [{ presentation: 'stopped-before-start' }, { kind: 'aside' }],
    // Stored red for clients that predate the orca-stop row; Orca stopped it, nothing failed.
    [
      { presentation: 'orca-stop', tone: 'error' },
      { kind: 'line', tone: 'notice' }
    ],
    [
      { presentation: 'compaction-skipped', tone: 'warning' },
      { kind: 'line', tone: 'warning' }
    ],
    [{ tone: 'error' }, { kind: 'line', tone: 'error' }],
    [{ tone: 'loud' }, { kind: 'line', tone: null }]
  ] as const)('reads %j as %j', (fields, look) => {
    expect(nativeChatNoticeLook(block(fields))).toEqual(look)
  })
})

describe('nativeChatNoticeBlock', () => {
  it('finds the block with a presentation or tone, and none in plain words', () => {
    const notice = block({ tone: 'warning' })
    expect(nativeChatNoticeBlock([block({}), notice])).toBe(notice)
    expect(nativeChatNoticeBlock([block({})])).toBeUndefined()
  })
})

const frame = (kind: string): NonNullable<NativeChatTextBlock['providerFrame']> => ({
  provider: 'codex',
  kind: `notification:${kind}`,
  payload: { head: '{}', byteLength: 2, digest: 'digest', truncated: false }
})

describe('notice disclosure classification', () => {
  it.each([
    ['configWarning', 'configuration'],
    ['deprecationNotice', 'deprecation']
  ] as const)('collapses a typed %s without reading its wording', (kind, label) => {
    expect(nativeChatNoticeLook(block({ tone: 'warning', providerFrame: frame(kind) }))).toEqual({
      kind: 'disclosure',
      label
    })
  })

  it('uses the retry fact across providers, even without a raw provider frame', () => {
    const look = nativeChatNoticeLook(
      block({
        tone: 'warning',
        failure: { kind: 'providerRetrying', retry: { attempt: 2, maxRetries: 5 } }
      })
    )
    expect(look.kind).toBe('disclosure')
    if (look.kind === 'disclosure') {
      expect(nativeChatNoticeDisclosureText(look)).toBe('Retrying · 2 of 5')
    }
  })

  it.each([
    { providerFrame: frame('warning') },
    { providerFrame: frame('guardianWarning') },
    { providerFrame: { ...frame('configWarning'), provider: 'other' } },
    { providerFrame: frame('configWarning'), presentation: 'turn-notice' },
    { providerFrame: frame('configWarning'), failure: { kind: 'usageLimitReached' } },
    { providerFrame: frame('configWarning'), failure: { kind: 'notSignedIn' } },
    { presentation: 'turn-notice' }
  ] satisfies Partial<NativeChatTextBlock>[])('keeps %j prominent', (fields) => {
    expect(nativeChatNoticeLook(block({ tone: 'warning', ...fields }))).toEqual({
      kind: 'line',
      tone: 'warning'
    })
  })

  it('does not fold a configuration frame carrying an explicit error tone', () => {
    expect(
      nativeChatNoticeLook(block({ tone: 'error', providerFrame: frame('configWarning') }))
    ).toEqual({
      kind: 'line',
      tone: 'error'
    })
  })
})
