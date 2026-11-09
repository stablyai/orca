// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { clearNativeChatComposerDraftsForTests } from '../../../drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../../drafts/native-chat-draft-scope'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { promptSkillRefs } from '../../../composer/editor/native-chat-prompt-document'

afterEach(() => clearNativeChatComposerDraftsForTests())

it('returns selected skills and images beside later typing without changing their owners', () => {
  const scope = structuredAgentSessionDraftScopeKey('session-1')
  updateNativeChatComposerDraft(
    scope,
    {
      text: 'new task with $audit',
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'new task with ' },
              { type: 'nativeChatSkill', attrs: { token: '$audit', path: '/later/audit/SKILL.md' } }
            ]
          }
        ]
      }
    },
    'immediate'
  )
  const body = structuredAgentSessionSendBody(
    'look at these with $audit',
    [
      { path: '/remote/a.png', previewUri: '/remote/a.png', connectionId: 'ssh-1' },
      { path: '/local/b.png', previewUri: '/local/b.png' }
    ],
    [{ name: 'audit', path: '/returned/audit/SKILL.md' }]
  )
  expect(handBackStructuredAgentSessionMessage('session-1', 'm1', body, ['ssh-1', null])).toBe(true)
  expect(handBackStructuredAgentSessionMessage('session-1', 'm1', body, ['ssh-1', null])).toBe(true)
  const draft = readNativeChatComposerDraft(scope)
  expect(draft.text).toBe('new task with $audit\n\nlook at these with $audit')
  expect(promptSkillRefs(draft.document)).toEqual([
    { name: 'audit', path: '/later/audit/SKILL.md' },
    { name: 'audit', path: '/returned/audit/SKILL.md' }
  ])
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
