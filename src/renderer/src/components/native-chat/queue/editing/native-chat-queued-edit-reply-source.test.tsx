// @vitest-environment happy-dom
import {
  script,
  harness,
  begin,
  withText,
  done,
  SCOPE,
  requestedFingerprint,
  submittedAs
} from './structured-queued-edit.test-fixture'
import { act } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
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

it('a queued reply edit the card changed under records no original for its words', async () => {
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

it('a queued reply edit the host refuses records no original for its words', async () => {
  for (const [words, answer] of [
    ['Why not?', done({ status: 'not-editable', messageId: 'card' })],
    [
      'Why so?',
      async () => ({
        kind: 'not-done' as const,
        notice: 'no',
        failure: { kind: 'refused' as const }
      })
    ]
  ] as const) {
    rememberNativeChatReplySource(SCOPE, quoted('Why?'), 'm-orig')
    const hook = harness(true, { messages: [withText(quoted('Why?'))] })
    await begin(hook)
    act(() => hook.result.current.editor?.change(words))
    script.answer = answer as typeof script.answer
    await act(async () => hook.result.current.editor?.save())
    expect(nativeChatReplySourceOf(SCOPE, quoted(words))).toBeUndefined()
    hook.unmount()
  }
})

it('an unconfirmed edit seen sent with the edited words records its original; one that is gone does not', async () => {
  const unconfirmed = async () => ({
    kind: 'not-done' as const,
    notice: 'lost',
    failure: { kind: 'unconfirmed' as const }
  })
  rememberNativeChatReplySource(SCOPE, quoted('What?'), 'm-orig')
  const sent = harness(true, { messages: [withText(quoted('What?'))] })
  await begin(sent)
  act(() => sent.result.current.editor?.change('What now?'))
  script.answer = unconfirmed
  await act(async () => sent.result.current.editor?.save())
  expect(nativeChatReplySourceOf(SCOPE, quoted('What now?'))).toBeUndefined()
  // The card left the queue as a submission holding exactly the edited words.
  sent.rerender({ messages: [], submissions: [submittedAs(quoted('What now?'))] })
  expect(nativeChatReplySourceOf(SCOPE, quoted('What now?'))).toBe('m-orig')
  sent.unmount()

  const gone = harness(true, { messages: [withText(quoted('What?'))] })
  await begin(gone)
  act(() => gone.result.current.editor?.change('What then?'))
  script.answer = unconfirmed
  await act(async () => gone.result.current.editor?.save())
  // The card left with no submission holding the edited words: nothing proves they were queued.
  gone.rerender({ messages: [] })
  expect(nativeChatReplySourceOf(SCOPE, quoted('What then?'))).toBeUndefined()
})

it("an update answered with another body's fingerprint records nothing", async () => {
  rememberNativeChatReplySource(SCOPE, quoted('Whose?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Whose?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('Whose is it?'))
  script.answer = done({ status: 'updated', messageId: 'card', fingerprint: '0'.repeat(64) })
  await act(async () => hook.result.current.editor?.save())
  expect(nativeChatReplySourceOf(SCOPE, quoted('Whose is it?'))).toBeUndefined()
})

it('a saved edit closes and records its original in its own chat only', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('How long?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('How long?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('How long now?'))
  script.answer = updatedAsRequested
  await act(async () => hook.result.current.editor?.save())
  // Nothing typed after Save: the editor closes.
  expect(hook.result.current.editor).toBeFalsy()
  expect(nativeChatReplySourceOf(SCOPE, quoted('How long now?'))).toBe('m-orig')
  expect(nativeChatReplySourceOf('another-chat', quoted('How long now?'))).toBeUndefined()
})

it('typing on while a save is out records the saved words, not the newer ones, and keeps editing', async () => {
  rememberNativeChatReplySource(SCOPE, quoted('Why that?'), 'm-orig')
  const hook = harness(true, { messages: [withText(quoted('Why that?'))] })
  await begin(hook)
  act(() => hook.result.current.editor?.change('Why that one?'))
  let answer: (() => void) | undefined
  script.answer = () =>
    new Promise((resolve) => {
      answer = () =>
        resolve({
          kind: 'done',
          value: { status: 'updated', messageId: 'card', fingerprint: requestedFingerprint() }
        })
    })
  let saving: Promise<unknown> | undefined
  act(() => {
    saving = Promise.resolve(hook.result.current.editor?.save())
  })
  // The editor keeps taking keystrokes while Save is out: they reach its draft directly.
  const draftScope = hook.result.current.editor!.draftScopeKey
  act(() =>
    updateNativeChatComposerDraft(
      draftScope,
      { text: 'Why that one, again?', document: undefined },
      'immediate'
    )
  )
  await act(async () => {
    answer!()
    await saving
  })
  expect(nativeChatReplySourceOf(SCOPE, quoted('Why that one?'))).toBe('m-orig')
  expect(nativeChatReplySourceOf(SCOPE, quoted('Why that one, again?'))).toBeUndefined()
  expect(hook.result.current.editor).toBeTruthy()
})
