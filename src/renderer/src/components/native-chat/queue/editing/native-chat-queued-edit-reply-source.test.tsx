// @vitest-environment happy-dom
import {
  script,
  harness,
  begin,
  withText,
  done,
  SCOPE
} from './structured-queued-edit.test-fixture'
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
  rememberNativeChatReplySource(SCOPE, quoted('Why?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Why?'))] })
  await begin(hook)
  for (const words of ['Why', 'Why,', 'Why, really?']) {
    act(() => hook.result.current.editor?.change(words))
  }
  expect(nativeChatReplySourceOf(SCOPE, quoted('Why, really?'))).toBeUndefined()
  script.answer = done({ status: 'updated', messageId: 'card', fingerprint: 'f'.repeat(64) })
  await act(async () => hook.result.current.editor?.save())
  expect(nativeChatReplySourceOf(SCOPE, quoted('Why, really?'))).toBe('m-orig')
})

it('a refused queued reply edit records no original for its words', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('How?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('How?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('How, exactly?'))
  // The card changed under the edit: the save is refused, so these words were never queued.
  script.answer = done({ status: 'changed', messageId: 'card' })
  await act(async () => hook.result.current.editor?.save())
  expect(nativeChatReplySourceOf(SCOPE, quoted('How, exactly?'))).toBeUndefined()
})

it('a queued reply edit ending in a space keeps its original under the text the card stores', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('When?'), 'm-orig')
  // With images supported the card stores its words without trailing whitespace.
  const hook = harness(true, { messages: [withText(quoted('When?'))], imagesCapable: true })
  await begin(hook)
  act(() => hook.result.current.editor?.change('When exactly? '))
  script.answer = done({ status: 'updated', messageId: 'card', fingerprint: 'f'.repeat(64) })
  await act(async () => hook.result.current.editor?.save())
  // The card keeps the words without the trailing space; reopening it reads them back that way.
  expect(nativeChatReplySourceOf(SCOPE, quoted('When exactly?'))).toBe('m-orig')
})
