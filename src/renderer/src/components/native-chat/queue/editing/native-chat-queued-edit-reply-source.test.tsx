// @vitest-environment happy-dom
import {
  script,
  harness,
  begin,
  withText,
  done,
  SCOPE,
  requestedFingerprint
} from './structured-queued-edit.test-fixture'
import { act } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import {
  nativeChatReplySourceOf,
  rememberNativeChatReplySource
} from '../../composer/reply/native-chat-reply-sources'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// The host's answer to an applied update: it now holds exactly the requested body.
const updatedAsRequested = async () => ({
  kind: 'done' as const,
  value: { status: 'updated' as const, messageId: 'card', fingerprint: requestedFingerprint() }
})

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
  script.answer = updatedAsRequested
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
  script.answer = updatedAsRequested
  await act(async () => hook.result.current.editor?.save())
  // The card keeps the words without the trailing space; reopening it reads them back that way.
  expect(nativeChatReplySourceOf(SCOPE, quoted('When exactly?'))).toBe('m-orig')
})

it('an unconfirmed edit records its original once the card is seen holding the edited words', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('Where?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Where?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('Where exactly?'))
  script.answer = async () => ({
    kind: 'not-done',
    notice: 'lost',
    failure: { kind: 'unconfirmed' }
  })
  await act(async () => hook.result.current.editor?.save())
  // No proof yet: nothing is recorded for words that may not be on the card.
  expect(nativeChatReplySourceOf(SCOPE, quoted('Where exactly?'))).toBeUndefined()
  hook.rerender({ messages: [withText(quoted('Where exactly?'))] })
  expect(nativeChatReplySourceOf(SCOPE, quoted('Where exactly?'))).toBe('m-orig')
})

it('an edit the host reports unchanged but holding the requested words records its original', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('Which?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Which?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('Which one?'))
  script.answer = async () => ({
    kind: 'done',
    value: { status: 'unchanged', messageId: 'card', fingerprint: requestedFingerprint() }
  })
  await act(async () => hook.result.current.editor?.save())
  expect(nativeChatReplySourceOf(SCOPE, quoted('Which one?'))).toBe('m-orig')
})

it('an unconfirmed edit with no proof records nothing', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('Who?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Who?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('Who else?'))
  script.answer = async () => ({
    kind: 'not-done',
    notice: 'lost',
    failure: { kind: 'unconfirmed' }
  })
  await act(async () => hook.result.current.editor?.save())
  hook.rerender({ messages: [withText(quoted('Who?'))] })
  expect(nativeChatReplySourceOf(SCOPE, quoted('Who else?'))).toBeUndefined()
})
