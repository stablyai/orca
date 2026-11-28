import { describe, expect, it } from 'vitest'
import type { MobilePushPrompt } from './notifications/mobile-push-contract'
import { attachMobilePushPrompt } from './mobile-push-prompt'

const small: MobilePushPrompt = {
  promptId: 'term:pty:ssh:1:26bea7ae07aef52f093a',
  options: [
    { optionId: 'allow_once', label: 'Allow once', role: 'approve' },
    { optionId: 'reject_once', label: 'Reject', role: 'deny' }
  ]
}

const notification = { title: 'Needs you', body: 'Bash', agentState: 'needs-input' as const }

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

describe('attachMobilePushPrompt', () => {
  it('returns the same notification when the gateway has not advertised support', () => {
    expect(attachMobilePushPrompt(notification, small, false)).toBe(notification)
    expect(notification).not.toHaveProperty('category')
  })

  it('attaches a category and a prompt that stay inside 3000 bytes', () => {
    const attached = attachMobilePushPrompt(notification, small, true)
    expect(attached).toEqual({ ...notification, category: 'orca.prompt', prompt: small })
    expect(bytes(attached)).toBeLessThanOrEqual(3000)
  })

  it('clips a long label and drops a blank one', () => {
    const attached = attachMobilePushPrompt(
      notification,
      {
        promptId: 'term:folder-pty:bdb13313988be0581b7b',
        options: [
          { optionId: 'allow_once', label: `  ${'b'.repeat(90)}  `, role: 'approve' },
          { optionId: 'reject_once', label: '   ', role: 'deny' }
        ]
      },
      true
    )
    expect(attached).toEqual({
      ...notification,
      category: 'orca.prompt',
      prompt: {
        promptId: 'term:folder-pty:bdb13313988be0581b7b',
        options: [{ optionId: 'allow_once', label: `${'b'.repeat(79)}…`, role: 'approve' }]
      }
    })
  })

  it('keeps the category and drops a prompt the 3000-byte cap cannot hold', () => {
    const fat: MobilePushPrompt = {
      promptId: 'p'.repeat(512),
      options: Array.from({ length: 12 }, (_, index) => ({
        optionId: `${index}`.padStart(256, 'o'),
        label: 'l'.repeat(80),
        role: 'approve' as const
      }))
    }
    const attached = attachMobilePushPrompt(notification, fat, true)
    expect(attached).toEqual({ ...notification, category: 'orca.prompt' })
    expect(attached).not.toHaveProperty('prompt')
    expect(bytes(attached)).toBeLessThanOrEqual(3000)
  })

  it('omits an id the gateway schema would reject and keeps the category', () => {
    const attached = attachMobilePushPrompt(
      notification,
      { promptId: 'p'.repeat(513), options: small.options },
      true
    )
    expect(attached).toEqual({ ...notification, category: 'orca.prompt' })
    const longOption = attachMobilePushPrompt(
      notification,
      {
        promptId: small.promptId,
        options: [{ optionId: 'o'.repeat(257), label: 'Allow', role: 'approve' }]
      },
      true
    )
    expect(longOption).toEqual({ ...notification, category: 'orca.prompt' })
  })

  it('returns the original object when even the category would pass 3000 bytes', () => {
    const base = { title: 't', body: 'x'.repeat(2958) }
    expect(bytes(base)).toBe(2981)
    expect(bytes({ ...base, category: 'orca.prompt' })).toBe(3006)
    expect(attachMobilePushPrompt(base, small, true)).toBe(base)
  })
})
