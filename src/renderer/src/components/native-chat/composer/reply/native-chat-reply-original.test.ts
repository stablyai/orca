// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { nativeChatMessageRowBlocks } from '../../messages/rows/native-chat-message-row-words'
import { nativeChatReplyOriginalId, nativeChatReplyRevealId } from './native-chat-reply-original'
import { nativeChatReplyExcerpt, withNativeChatReplyContext } from './native-chat-reply-quote'
import type * as Quote from './native-chat-reply-quote'
import {
  NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS,
  rememberNativeChatReplySource,
  resetNativeChatReplySourcesForTests
} from './native-chat-reply-sources'
import {
  NATIVE_CHAT_REPLY_TARGETS_MAX,
  nativeChatReplyTargetFromSentText,
  readNativeChatReplyTarget,
  releaseNativeChatReplyScope,
  resetNativeChatReplyTargetsForTests,
  setNativeChatReplyTarget
} from './native-chat-reply-target'

const quote = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./native-chat-reply-quote', async (load) => {
  const real = await load<typeof Quote>()
  return {
    ...real,
    nativeChatReplyExcerpt: (text: string) => {
      quote.calls += 1
      return real.nativeChatReplyExcerpt(text)
    }
  }
})

const text = (value: string) => ({ type: 'text' as const, text: value })
const message = (
  id: string,
  role: 'assistant' | 'user',
  blocks: NativeChatMessage['blocks']
): Pick<NativeChatMessage, 'id' | 'role' | 'blocks'> => ({ id, role, blocks })

beforeEach(() => {
  localStorage.clear()
  resetNativeChatReplyTargetsForTests()
  resetNativeChatReplySourcesForTests()
})

it('a reply rebuilt from words sent to two identical messages stays unavailable with one of them loaded', () => {
  const sent = withNativeChatReplyContext('Which one?', { author: 'agent', excerpt: 'Done.' }, 'x')
  rememberNativeChatReplySource('chat-a', sent, 'm-first')
  rememberNativeChatReplySource('chat-a', sent, 'm-second')
  const target = nativeChatReplyTargetFromSentText(sent, 'chat-a').target
  // Its words alone would pick the one duplicate loaded, which may be the wrong message. Instead it
  // names an original no loaded message has, so the transcript shows it as unavailable.
  expect(
    nativeChatReplyOriginalId([message('m-second', 'assistant', [text('Done.')])], target!)
  ).toBe('m-second')
  expect(target?.messageId).toBe(NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS)
})

it('finds the user’s own message that carried a sent image, as its Reply read it', () => {
  const sent = message('m-img', 'user', [
    text('[Image #1] Why is this button blue?'),
    { type: 'image-ref', path: '/tmp/shot.png' }
  ])
  // The Reply action quotes the row's words, which leave the image marker out.
  const words = deriveNativeChatRowContent(nativeChatMessageRowBlocks(sent)).markdown
  expect(words).toBe('Why is this button blue?')
  expect(
    nativeChatReplyOriginalId([sent], { author: 'user', excerpt: nativeChatReplyExcerpt(words) })
  ).toBe('m-img')
})

it('finds a long agent message with an empty text block, cut where its Reply cut it', () => {
  const long = message('m-gap', 'assistant', [
    text('First part. '.repeat(30)),
    text(''),
    text('Second part. '.repeat(30))
  ])
  // The words an agent row draws and its Reply quotes.
  const excerpt = nativeChatReplyExcerpt(
    deriveNativeChatRowContent(nativeChatMessageRowBlocks(long)).markdown
  )
  expect(excerpt.endsWith('…')).toBe(true)
  expect(nativeChatReplyOriginalId([long], { author: 'agent', excerpt })).toBe('m-gap')
})

it('rereads only messages that changed when the transcript updates', () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    message(`m-${index}`, 'assistant', [text(`Answer ${index}.`)])
  )
  const target = { author: 'agent' as const, excerpt: 'Answer 7.' }
  expect(nativeChatReplyOriginalId(messages, target)).toBe('m-7')
  quote.calls = 0
  // A streamed chunk replaces one message; the rest keep their blocks.
  const next = [...messages.slice(0, 19), message('m-19', 'assistant', [text('Answer 19, more.')])]
  expect(nativeChatReplyOriginalId(next, target)).toBe('m-7')
  // The lookup's own excerpt, plus the changed message.
  expect(quote.calls).toBe(1)
})

const reply = (id: string) => ({
  id,
  messageId: `m-${id}`,
  author: 'agent' as const,
  excerpt: 'Done.'
})

it('a queued edit’s reply never pushes a chat’s reply out, in memory or in storage', () => {
  for (let index = 0; index < NATIVE_CHAT_REPLY_TARGETS_MAX; index += 1) {
    setNativeChatReplyTarget(`chat-${index}`, reply(`r${index}`))
  }
  setNativeChatReplyTarget('queued-edit:card', reply('edit'), { ephemeral: true })
  expect(readNativeChatReplyTarget('chat-0')?.id).toBe('r0')
  releaseNativeChatReplyScope('queued-edit:card')
  resetNativeChatReplyTargetsForTests()
  expect(readNativeChatReplyTarget('chat-0')?.id).toBe('r0')
})

it('opening and closing a queued edit’s reply writes nothing to storage', () => {
  setNativeChatReplyTarget('chat-a', reply('a'))
  const KEY = 'orca.nativeChat.replyTargets.v1'
  localStorage.setItem(KEY, 'unchanged')
  for (let round = 0; round < 3; round += 1) {
    setNativeChatReplyTarget('queued-edit:card', reply('edit'), { ephemeral: true })
    releaseNativeChatReplyScope('queued-edit:card')
  }
  expect(localStorage.getItem(KEY)).toBe('unchanged')
})

it('saving a chat’s reply while a queued edit is open stores only the chat’s', () => {
  setNativeChatReplyTarget('queued-edit:card', reply('edit'), { ephemeral: true })
  setNativeChatReplyTarget('chat-a', reply('a'))
  const stored: unknown = JSON.parse(
    localStorage.getItem('orca.nativeChat.replyTargets.v1') ?? '[]'
  )
  const keys = Array.isArray(stored)
    ? stored.map((entry: unknown) => (Array.isArray(entry) ? entry[0] : null))
    : null
  expect(keys).toEqual(['chat-a'])
})

it('a reply naming an original that isn’t loaded is unavailable, even when other words match', () => {
  const other = message('m-other', 'assistant', [text('Done.')])
  const target = { messageId: 'm-gone', author: 'agent' as const, excerpt: 'Done.' }
  expect(
    nativeChatReplyRevealId(
      target,
      () => false,
      () => [other]
    )
  ).toBeNull()
  expect(
    nativeChatReplyRevealId(
      target,
      (id) => id === 'm-gone',
      () => [other]
    )
  ).toBe('m-gone')
  // Naming none, it is found by its words.
  expect(
    nativeChatReplyRevealId(
      { ...target, messageId: '' },
      () => false,
      () => [other]
    )
  ).toBe('m-other')
})

it('the same words sent in two chats each keep their own chat’s original', () => {
  const sent = withNativeChatReplyContext('Which one?', { author: 'agent', excerpt: 'Done.' }, 'x')
  rememberNativeChatReplySource('chat-a', sent, 'm-a')
  rememberNativeChatReplySource('chat-b', sent, 'm-b')
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-a').target?.messageId).toBe('m-a')
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-b').target?.messageId).toBe('m-b')
  // Words recorded only in chat A name nothing in chat C, which finds its original by words.
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-c').target?.messageId).toBe('')
  // Answering two messages inside one chat is still ambiguous there, and only there.
  rememberNativeChatReplySource('chat-a', sent, 'm-a2')
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-a').target?.messageId).toBe(
    NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS
  )
  resetNativeChatReplySourcesForTests()
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-b').target?.messageId).toBe('m-b')
})

it('drops records from before replies were kept per chat, rather than trusting them anywhere', () => {
  localStorage.setItem('orca.nativeChat.replySources.v1', JSON.stringify([['3:abc', 'm-old']]))
  resetNativeChatReplySourcesForTests()
  const sent = withNativeChatReplyContext('Why?', { author: 'agent', excerpt: 'Done.' }, 'x')
  expect(nativeChatReplyTargetFromSentText(sent, 'chat-a').target?.messageId).toBe('')
  expect(localStorage.getItem('orca.nativeChat.replySources.v1')).toBeNull()
})
