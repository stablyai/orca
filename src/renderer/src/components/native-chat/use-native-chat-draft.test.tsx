// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { useNativeChatDraft } from './use-native-chat-draft'

afterEach(() => clearNativeChatComposerDraftsForTests())

const scopeKey = structuredAgentSessionDraftScopeKey('session-1')
const body = structuredAgentSessionSendBody('look at this', [
  { path: '/local/a.png', previewUri: '/local/a.png' }
])

function renderDraft(): {
  composing: { current: boolean }
  result: { current: ReturnType<typeof useNativeChatDraft> }
} {
  const composing = { current: false }
  const { result } = renderHook(() => useNativeChatDraft(scopeKey, () => composing.current))
  return { composing, result }
}

it('shows a message returned during a composition once the composition updates', () => {
  const { composing, result } = renderDraft()
  act(() => result.current.setDraft('typed'))
  composing.current = true
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  expect(result.current.draft).toBe('typed')
  act(() => result.current.setDraft((shown) => `${shown}가`))
  expect(readNativeChatDraftCache(scopeKey)).toBe('typed가\n\nlook at this')
})

it('does not add a message again when its return is retried during a composition', () => {
  const { composing, result } = renderDraft()
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  act(() => result.current.setDraft((shown) => `${shown} and more`))
  composing.current = true
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  act(() => result.current.setDraft((shown) => `${shown}가`))
  expect(readNativeChatDraftCache(scopeKey)).toBe('look at this and more가')
})
