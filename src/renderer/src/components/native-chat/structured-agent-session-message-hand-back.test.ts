// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'

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

it('marks only the expired image of a returned message, so the other can still be sent', () => {
  const expired = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
  const fresh = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
  const store = '/srv/agent-session-attachments'
  const body = structuredAgentSessionSendBody('look at these', [
    { path: `${store}/${expired}/old.png`, previewUri: 'a' },
    { path: `${store}/${fresh}/old.png`, previewUri: 'b' }
  ])
  handBackStructuredAgentSessionMessage('session-1', 'm1', body, undefined, new Set([expired]))
  const draft = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('session-1'))
  expect(draft.images).toEqual([
    { id: 'returned-m1-1', path: '', unavailableName: 'old.png' },
    { id: 'returned-m1-2', path: `${store}/${fresh}/old.png` }
  ])
})
