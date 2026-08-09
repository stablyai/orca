import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  armNativeChatDeliveryCheck,
  assignMatchingPromptSubmissions,
  hasMatchingPromptSubmission,
  nativeChatPromptDigest
} from './native-chat-prompt-delivery'

describe('native chat prompt delivery', () => {
  it('hashes the full exact multiline Unicode prompt', () => {
    const prompt = `  ${'long '.repeat(60)}\nsecond line 🚀  `
    const expected = createHash('sha256').update(prompt).digest('hex')
    expect(nativeChatPromptDigest(prompt)).toBe(`sha256:${expected}`)
  })

  it('requires an exact digest from a newer occurrence in the same stream', () => {
    const expectedDigest = nativeChatPromptDigest('hello')
    const check = armNativeChatDeliveryCheck(
      {
        expectedDigest,
        baseline: { streamId: 'stream-a', sequence: 4, digest: 'old', receivedAt: 10 }
      },
      20
    )

    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-a', sequence: 4, digest: expectedDigest, receivedAt: 21 }
      ])
    ).toBe(false)
    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-a', sequence: 5, digest: 'sha256:wrong', receivedAt: 21 }
      ])
    ).toBe(false)
    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-a', sequence: 5, digest: expectedDigest, receivedAt: 21 }
      ])
    ).toBe(true)
  })

  it('accepts only a newer matching occurrence from a newly observed stream', () => {
    const expectedDigest = nativeChatPromptDigest('hello')
    const check = armNativeChatDeliveryCheck(
      {
        expectedDigest,
        baseline: { streamId: 'stream-a', sequence: 9, digest: 'old', receivedAt: 10 }
      },
      20
    )

    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-b', sequence: 1, digest: expectedDigest, receivedAt: 1 }
      ])
    ).toBe(false)
    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-b', sequence: 1, digest: expectedDigest, receivedAt: 30 }
      ])
    ).toBe(true)
  })

  it('rejects a matching occurrence received before an unbased send was armed', () => {
    const expectedDigest = nativeChatPromptDigest('hello')
    const check = armNativeChatDeliveryCheck({ expectedDigest }, 20)

    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-a', sequence: 1, digest: expectedDigest, receivedAt: 19 }
      ])
    ).toBe(false)
    expect(
      hasMatchingPromptSubmission(check, [
        { streamId: 'stream-a', sequence: 2, digest: expectedDigest, receivedAt: 20 }
      ])
    ).toBe(true)
  })

  it('assigns one occurrence to only one repeated pending send', () => {
    const expectedDigest = nativeChatPromptDigest('repeat')
    const check = armNativeChatDeliveryCheck({ expectedDigest }, 20)
    const occurrence = {
      streamId: 'stream-a',
      sequence: 1,
      digest: expectedDigest,
      receivedAt: 21
    }

    const first = assignMatchingPromptSubmissions(
      [
        { id: 'first', deliveryCheck: check },
        { id: 'second', deliveryCheck: check }
      ],
      [occurrence]
    )
    expect([...first.keys()]).toEqual(['first'])

    const reserved = assignMatchingPromptSubmissions(
      [
        { id: 'first', deliveryCheck: { ...check, acknowledgedBy: occurrence } },
        { id: 'second', deliveryCheck: check }
      ],
      [occurrence]
    )
    expect([...reserved.keys()]).toEqual(['first'])
  })
})
