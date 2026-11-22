import { afterEach, expect, it, vi } from 'vitest'
import type * as ImageRows from './native-chat-image-delivery-row'
import type * as ImagePaste from '../../input/composer/agent-image-paste'
import type { NativeChatMessage } from '../../native-chat-types'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

const operations = vi.hoisted(() => ({ reads: 0, counts: 0 }))
vi.mock('../../input/composer/agent-image-paste', async (importOriginal) => {
  const actual = await importOriginal<typeof ImagePaste>()
  return {
    ...actual,
    readAgentImageSourceContext: (text: string) => {
      operations.reads++
      return actual.readAgentImageSourceContext(text)
    }
  }
})
vi.mock('./native-chat-image-delivery-row', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageRows>()
  return {
    ...actual,
    nativeChatUserMessageContentKey: (
      ...args: Parameters<typeof actual.nativeChatUserMessageContentKey>
    ) => {
      if (args[0].role === 'user') {
        operations.counts++
      }
      return actual.nativeChatUserMessageContentKey(...args)
    }
  }
})
afterEach(() => {
  operations.reads = 0
  operations.counts = 0
})

it.each([20, 200])(
  'keeps source normalization and failed-send retention bounded across %i completed images',
  (count) => {
    const failed: NativeChatPendingSend = {
      id: 'failed',
      text: '',
      imagePaths: ['/repo/rejected.png'],
      sentAt: 0,
      delivery: 'rejected',
      afterMessageId: 'boundary'
    }
    const transcript: NativeChatMessage[] = [
      { id: 'boundary', role: 'assistant', blocks: [], timestamp: 0, source: 'transcript' }
    ]
    let pending = [failed]
    for (let i = 0; i < count; i++) {
      const copy = `/temp/view-${i}.png`
      const send: NativeChatPendingSend = {
        id: `pending-${i}`,
        text: '',
        imagePaths: ['/repo/shot.png'],
        deliveredImagePaths: [copy],
        sentAt: i + 1,
        afterMessageId: 'boundary',
        matchingOccurrence: i + 1
      }
      transcript.push(
        {
          id: `user-${i}`,
          role: 'user',
          source: 'transcript',
          timestamp: i * 2 + 1,
          blocks: [
            { type: 'image-ref', path: copy },
            {
              type: 'text',
              text: `[Image source file: "/repo/shot.png"; attached viewing copy: "${copy}"]`
            }
          ]
        },
        {
          id: `reply-${i}`,
          role: 'assistant',
          timestamp: i * 2 + 2,
          blocks: [],
          source: 'transcript'
        }
      )
      pending = prunePendingSends([...pending, send], transcript)
      expect(pending.map((entry) => entry.id)).toEqual(['failed'])
      expect(pending[0].claimedImageRowIds ?? []).toEqual([])
      pendingSendsAsMessages(pending, transcript)
    }
    expect(operations.reads).toBe(count)
    pendingSendsAsMessages(pending, transcript)
    prunePendingSends(pending, transcript)
    expect(operations.reads).toBe(count)
  }
)

it.each([200, 2000])(
  'counts %i tail user rows once per reconciliation despite generated-row preclaiming',
  (count) => {
    const pending: NativeChatPendingSend[] = [
      {
        id: 'pending',
        text: 'queued caption',
        imagePaths: ['/repo/a.png'],
        sentAt: 1,
        afterMessageId: 'boundary'
      }
    ]
    const transcript: NativeChatMessage[] = [
      { id: 'boundary', role: 'assistant', blocks: [], timestamp: 0, source: 'transcript' },
      ...Array.from({ length: count }, (_, index): NativeChatMessage => ({
        id: `row-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `other-${index}` }],
        timestamp: index + 2,
        source: 'transcript'
      })),
      { id: 'reply', role: 'assistant', blocks: [], timestamp: count + 3, source: 'transcript' }
    ]
    operations.counts = 0
    expect(prunePendingSends(pending, transcript).map((entry) => entry.id)).toEqual(['pending'])
    expect(operations.counts).toBe(count)
    operations.counts = 0
    expect(pendingSendsAsMessages(pending, transcript).map((entry) => entry.id)).toEqual([
      'pending:pending'
    ])
    expect(operations.counts).toBe(count)
  }
)
