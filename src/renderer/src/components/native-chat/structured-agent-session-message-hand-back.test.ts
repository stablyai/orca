import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import {
  handBackStructuredAgentSessionMessage,
  returnMessageToComposer
} from './structured-agent-session-message-hand-back'

afterEach(() => clearNativeChatComposerDraftsForTests())

it('gives a message back to its conversation draft, each image on the host it lives on', () => {
  const body = structuredAgentSessionSendBody('look at these', [
    { path: '/remote/a.png', previewUri: '/remote/a.png', connectionId: 'ssh-1' },
    { path: '/local/b.png', previewUri: '/local/b.png' }
  ])
  expect(handBackStructuredAgentSessionMessage('session-1', 'm1', body, ['ssh-1', null])).toBe(true)
  const draft = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('session-1'))
  expect(draft.text).toBe('look at these')
  expect(draft.images).toEqual([
    {
      id: 'returned-m1-1',
      path: '/remote/a.png',
      connectionId: 'ssh-1',
      reference: { path: '/remote/a.png' }
    },
    { id: 'returned-m1-2', path: '/local/b.png', reference: { path: '/local/b.png' } }
  ])
})

it('preserves URL/alt references and picked nodes through storage and repeated handback', () => {
  const scope = structuredAgentSessionDraftScopeKey('references')
  const reference = { url: 'https://example.com/image.png', alt: 'a diagram' }
  const blocks = [
    { type: 'text' as const, text: '$reviewer then $review' },
    { type: 'image-ref' as const, ...reference }
  ]
  for (const attempt of ['first', 'second']) {
    expect(
      returnMessageToComposer(scope, attempt, blocks, undefined, {
        skills: [{ name: 'review', path: '/skills/review' }],
        textPolicy: 'append-repeated'
      })
    ).toBe(true)
  }
  const saved = parseStoredNativeChatComposerDraft(
    JSON.parse(JSON.stringify({ ...readNativeChatComposerDraft(scope), savedAt: 1 }))
  )!
  expect(saved.text).toBe('$reviewer then $review\n\n$reviewer then $review')
  expect(
    saved.document?.content
      ?.flatMap((node) => node.content ?? [])
      .filter((node) => node.type === 'nativeChatSkill')
  ).toEqual([
    { type: 'nativeChatSkill', attrs: { token: '$review', path: '/skills/review' } },
    { type: 'nativeChatSkill', attrs: { token: '$review', path: '/skills/review' } }
  ])
  expect(
    structuredAgentSessionSendBody(
      saved.text,
      saved.images.map((image) => ({ ...image, previewUri: '' }))
    ).blocks.slice(1)
  ).toEqual([
    { type: 'image-ref', ...reference },
    { type: 'image-ref', ...reference }
  ])
})
