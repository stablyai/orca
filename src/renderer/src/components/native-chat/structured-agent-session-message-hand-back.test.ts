// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  conversationReferenceToken,
  conversationReferenceUri,
  withConversationReferenceInstructions
} from '../../../../shared/conversation-reference'

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
    { id: 'returned-m1-1', path: '/remote/a.png', connectionId: 'ssh-1' },
    { id: 'returned-m1-2', path: '/local/b.png' }
  ])
})

it('returns a conversation reference without exposing its agent reading instructions in the draft', () => {
  const prompt = conversationReferenceToken({
    uri: conversationReferenceUri('12345678-1234-4234-8234-123456789abc'),
    title: 'Earlier work',
    agent: 'codex'
  })
  const body = structuredAgentSessionSendBody(withConversationReferenceInstructions(prompt), [])
  expect(
    handBackStructuredAgentSessionMessage('session-reference', 'reference-message', body)
  ).toBe(true)
  expect(
    readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('session-reference')).text
  ).toBe(prompt)
})
