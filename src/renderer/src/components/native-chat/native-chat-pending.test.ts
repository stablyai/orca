import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatPendingSend } from '../../../../shared/native-chat-pending-sends'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  isLaunchPromptMessageId,
  launchPromptAsMessage,
  nextNativeChatPendingSendId,
  readPendingSendCache,
  shouldPruneLaunchPrompt,
  writePendingSendCache
} from './native-chat-pending'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  clearCommandMarkerCacheForTests,
  commandMarkersAsMessages,
  readCommandMarkerCache
} from './native-chat-command-marker'
import { stripNoiseMessages } from './native-chat-noise'

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

const pendingOf = (id: string, text: string): NativeChatPendingSend => ({ id, text, sentAt: 100 })

describe('launchPromptAsMessage', () => {
  it('maps a launch prompt to a tab-keyed scrape-source user message', () => {
    expect(
      launchPromptAsMessage({
        tabId: 'tab-1',
        agent: 'codex',
        text: 'Fix failing checks',
        createdAt: 42
      })
    ).toEqual({
      id: 'launch-pending:tab-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix failing checks' }],
      timestamp: 42,
      source: 'scrape'
    })
  })

  it('hides the launch prompt while its transcript user turn is visible', () => {
    expect(
      launchPromptAsMessage(
        {
          tabId: 'tab-1',
          agent: 'codex',
          text: 'Fix failing checks',
          createdAt: 42
        },
        [{ ...userMessage('u1', 'Fix failing checks'), timestamp: 43 }]
      )
    ).toBeNull()
  })

  it('uses pending-send normalization for large multiline generated prompts', () => {
    const prompt = [
      '[Image #1] Resolve the failing checks:',
      '',
      'Resolve the failing checks:',
      '',
      '- lint failed',
      '  fix spacing'
    ].join('\n')
    const transcript = [
      {
        ...userMessage(
          'u1',
          'Resolve the failing checks: Resolve the failing checks: - lint failed fix spacing'
        ),
        timestamp: 43
      },
      { ...assistantMessage('a1', 'I will fix it'), timestamp: 44 }
    ]

    expect(
      shouldPruneLaunchPrompt(
        {
          tabId: 'tab-1',
          agent: 'codex',
          text: prompt,
          createdAt: 42
        },
        transcript
      )
    ).toBe(true)
  })

  it('keeps the launch prompt until the transcript advances past the user turn', () => {
    const prompt = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'Fix failing checks',
      createdAt: 42
    }

    expect(
      shouldPruneLaunchPrompt(prompt, [
        { ...userMessage('u1', 'Fix failing checks'), timestamp: 43 }
      ])
    ).toBe(false)
    expect(
      shouldPruneLaunchPrompt(prompt, [
        { ...userMessage('u1', 'Fix failing checks'), timestamp: 43 },
        { ...assistantMessage('a1', 'working'), timestamp: 44 }
      ])
    ).toBe(true)
  })

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

describe('pending send cache', () => {
  it('persists optimistic sends for the same pane and agent', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex' }

    const appended = appendPendingSendCache(scope, pendingOf('p1', 'first prompt'))

    expect(appended).toEqual([pendingOf('p1', 'first prompt')])
    expect(readPendingSendCache(scope)).toEqual(appended)
    expect(readPendingSendCache({ ...scope, agent: 'claude' })).toEqual([])
  })

  it('mints unique ids across chat-view remounts while the cache survives', () => {
    clearPendingSendCacheForTests()
    const first = nextNativeChatPendingSendId(100)
    const second = nextNativeChatPendingSendId(100)
    expect(second).not.toBe(first)
  })

  it('clears cached pending sends when pruning removes all entries', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex' }
    appendPendingSendCache(scope, pendingOf('p1', 'first prompt'))

    writePendingSendCache(scope, [])

    expect(readPendingSendCache(scope)).toEqual([])
  })
})

describe('isLaunchPromptMessageId', () => {
  it('recognizes the launch prompt id prefix', () => {
    expect(isLaunchPromptMessageId('launch-pending:tab-1')).toBe(true)
    expect(isLaunchPromptMessageId('pending:p1')).toBe(false)
  })
})

describe('commandMarkersAsMessages', () => {
  it('renders a slash command as a system "Ran <cmd>" message', () => {
    expect(commandMarkersAsMessages([{ id: 'c1', command: '/clear', sentAt: 7 }])).toEqual([
      {
        id: 'command:c1',
        role: 'system',
        blocks: [{ type: 'text', text: 'Ran /clear' }],
        timestamp: 7,
        source: 'scrape'
      }
    ])
  })

  it('survives stripNoiseMessages (the "Ran" text is not a noise prefix)', () => {
    const markers = commandMarkersAsMessages([{ id: 'c1', command: '/compact', sentAt: 1 }])
    expect(stripNoiseMessages(markers)).toEqual(markers)
  })
})

describe('command marker cache', () => {
  it('persists slash command markers for the same pane conversation', () => {
    clearCommandMarkerCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex', sessionId: 'session-1' }

    const appended = appendCommandMarkerCache(scope, '/clear', 10)

    expect(appended).toEqual([{ id: '10-1', command: '/clear', sentAt: 10 }])
    expect(readCommandMarkerCache(scope)).toEqual(appended)
    expect(readCommandMarkerCache({ ...scope, sessionId: 'session-2' })).toEqual([])
  })

  it('caps cached command markers to the latest eight', () => {
    clearCommandMarkerCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'claude', sessionId: 'session-1' }

    for (let i = 0; i < 10; i += 1) {
      appendCommandMarkerCache(scope, `/cmd-${i}`, i)
    }

    expect(readCommandMarkerCache(scope).map((marker) => marker.command)).toEqual([
      '/cmd-2',
      '/cmd-3',
      '/cmd-4',
      '/cmd-5',
      '/cmd-6',
      '/cmd-7',
      '/cmd-8',
      '/cmd-9'
    ])
  })
})

describe('applyCommandMarkerBoundaries', () => {
  it('hides existing transcript messages after a local /clear marker', () => {
    const messages = [
      userMessage('before', 'old prompt'),
      { ...assistantMessage('after', 'new answer'), timestamp: 20 }
    ]

    expect(
      applyCommandMarkerBoundaries(messages, [{ id: 'c1', command: '/clear', sentAt: 10 }])
    ).toEqual([{ ...assistantMessage('after', 'new answer'), timestamp: 20 }])
  })

  it('keeps messages for non-clear commands like /compact', () => {
    const messages = [userMessage('before', 'old prompt')]

    expect(
      applyCommandMarkerBoundaries(messages, [{ id: 'c1', command: '/compact', sentAt: 10 }])
    ).toBe(messages)
  })

  it('uses the latest clear marker as the visible boundary', () => {
    const messages = [
      { ...userMessage('old', 'old'), timestamp: 5 },
      { ...userMessage('middle', 'middle'), timestamp: 15 },
      { ...userMessage('new', 'new'), timestamp: 25 }
    ]

    expect(
      applyCommandMarkerBoundaries(messages, [
        { id: 'c1', command: '/clear', sentAt: 10 },
        { id: 'c2', command: '/clear', sentAt: 20 }
      ]).map((message) => message.id)
    ).toEqual(['new'])
  })
})

describe('scope-cache key counts stay bounded (memory-leak regression)', () => {
  // Per-key limits alone leaked ephemeral scope keys; both caches also cap keys at 128 (#7566).
  const CAP = 128

  it('appendCommandMarkerCache evicts the oldest scope key past the cap', () => {
    clearCommandMarkerCacheForTests()
    for (let i = 0; i < CAP + 5; i++) {
      appendCommandMarkerCache(
        { paneKey: 'tab:leaf', agent: 'claude', sessionId: `s${i}` },
        '/clear'
      )
    }
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: 's0' })
    ).toEqual([])
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: 's4' })
    ).toEqual([])
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: `s${CAP + 4}` })
    ).toHaveLength(1)
  })

  it('writePendingSendCache evicts the oldest scope key past the cap', () => {
    clearPendingSendCacheForTests()
    const send = (id: string): NativeChatPendingSend => ({ id, text: id, sentAt: 1 })
    for (let i = 0; i < CAP + 5; i++) {
      writePendingSendCache({ paneKey: `tab-${i}:leaf`, agent: 'claude' }, [send(`m${i}`)])
    }
    expect(readPendingSendCache({ paneKey: 'tab-0:leaf', agent: 'claude' })).toEqual([])
    expect(readPendingSendCache({ paneKey: `tab-${CAP + 4}:leaf`, agent: 'claude' })).toHaveLength(
      1
    )
  })
})

describe('commandMarkersAsMessages with a host answer', () => {
  it('shows the answer in place of the Ran line', () => {
    const [message] = commandMarkersAsMessages([
      { id: 'c2', command: '/context', sentAt: 9, output: 'Context: 54.6k / 200k tokens (27%)' }
    ])
    expect(message?.role).toBe('system')
    expect(message?.blocks).toEqual([{ type: 'text', text: 'Context: 54.6k / 200k tokens (27%)' }])
  })
})
