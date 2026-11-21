// @vitest-environment happy-dom
import { script, harness, begin, withText, done } from './structured-queued-edit.test-fixture'
import { act } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import {
  nativeChatReplySourceOf,
  rememberNativeChatReplySource
} from '../../composer/reply/native-chat-reply-sources'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const quoted = (words: string): string =>
  withNativeChatReplyContext(words, { author: 'agent', excerpt: 'Old.', agentLabel: 'Claude' }, 'x')

it('a queued reply edit records its original only when the update is accepted, never while typing', async () => {
  rememberNativeChatReplySource(quoted('Why?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Why?'))] })
  await begin(hook)
  for (const words of ['Why', 'Why,', 'Why, really?']) {
    act(() => hook.result.current.editor?.change(words))
  }
  expect(nativeChatReplySourceOf(quoted('Why, really?'))).toBeUndefined()
  script.answer = done({ status: 'updated', messageId: 'card', fingerprint: 'f'.repeat(64) })
  await act(async () => hook.result.current.editor?.save())
  expect(nativeChatReplySourceOf(quoted('Why, really?'))).toBe('m-orig')
})
