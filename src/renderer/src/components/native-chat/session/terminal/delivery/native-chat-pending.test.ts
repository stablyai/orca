import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'

import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS,
  shouldSuppressNativeChatExitForPane,
  writePendingSendCache,
  launchPromptAsMessage,
  shouldPruneLaunchPrompt
} from './native-chat-pending'

function userMessage(id: string, text: string, timestamp = 1): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function assistantMessage(id: string, text: string, timestamp = 2): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

describe('launchPromptAsMessage', () => {
  // Grok has no timestamps; excluding its rows stranded launch echoes at the transcript tail.
  it('hides and prunes the launch prompt against a timestampless transcript (grok)', () => {
    const entry = { tabId: 'tab-1', agent: 'grok' as const, text: 'rename it', createdAt: 42 }
    const transcript = [
      { ...userMessage('u1', 'rename it'), timestamp: null },
      { ...assistantMessage('a1', 'done'), timestamp: null }
    ]

    expect(launchPromptAsMessage(entry, transcript)).toBeNull()
    expect(shouldPruneLaunchPrompt(entry, transcript)).toBe(true)
  })

  it('does not bind a launch prompt to an older identical completed turn', () => {
    const entry = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'run tests',
      createdAt: 100
    }
    const oldHistory = [
      { ...userMessage('old-user', 'run tests'), timestamp: 10 },
      { ...assistantMessage('old-answer', 'passed'), timestamp: 20 }
    ]

    expect(launchPromptAsMessage(entry, oldHistory)).not.toBeNull()
    expect(shouldPruneLaunchPrompt(entry, oldHistory)).toBe(false)
  })
})

describe('shouldSuppressNativeChatExitForPane', () => {
  it('suppresses exit while an optimistic send is pending or within grace (#10098)', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-1:leaf-a', agent: 'codex' }
    const sentAt = 1_000
    appendPendingSendCache(scope, {
      id: 'p1',
      text: 'ordinary prose',
      sentAt
    })
    expect(shouldSuppressNativeChatExitForPane(scope.paneKey, sentAt + 10)).toBe(true)
    writePendingSendCache(scope, [])
    expect(
      shouldSuppressNativeChatExitForPane(
        scope.paneKey,
        sentAt + NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS - 1
      )
    ).toBe(true)
    expect(
      shouldSuppressNativeChatExitForPane(scope.paneKey, sentAt + NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS)
    ).toBe(false)
  })

  it('does not suppress unrelated panes', () => {
    clearPendingSendCacheForTests()
    appendPendingSendCache(
      { paneKey: 'tab-1:leaf-a', agent: 'codex' },
      { id: 'p1', text: 'hi', sentAt: 50 }
    )
    expect(shouldSuppressNativeChatExitForPane('tab-1:leaf-b', 60)).toBe(false)
  })
})
