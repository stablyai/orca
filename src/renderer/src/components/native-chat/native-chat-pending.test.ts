import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  clearCommandMarkerCacheForTests,
  clearPendingSendCacheForTests,
  commandMarkersAsMessages,
  isCommandMarkerId,
  isLaunchPromptMessageId,
  isPendingMessageId,
  launchPromptAsMessage,
  pendingSendsAsMessages,
  prunePendingSends,
  readCommandMarkerCache,
  readPendingSendCache,
  shouldPruneLaunchPrompt,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import { stripNoiseMessages } from './native-chat-noise'

function userMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function assistantMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
    source: 'transcript'
  }
}

const pendingOf = (id: string, text: string): NativeChatPendingSend => ({ id, text, sentAt: 100 })

describe('prunePendingSends', () => {
  it('returns the same reference when there is nothing pending', () => {
    const pending: NativeChatPendingSend[] = []
    expect(prunePendingSends(pending, [userMessage('m1', 'hi')])).toBe(pending)
  })

  it('keeps a pending send while only its user turn has landed', () => {
    const pending = [pendingOf('p1', 'fix the bug')]
    const next = prunePendingSends(pending, [userMessage('m1', 'fix the bug')])
    expect(next).toBe(pending)
  })

  it('drops a pending send once the transcript advances beyond its user turn', () => {
    const pending = [pendingOf('p1', 'fix the bug')]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'fix the bug'),
      assistantMessage('m2', 'working on it')
    ])
    expect(next).toEqual([])
  })

  it('matches advanced turns ignoring surrounding/collapsed whitespace', () => {
    const pending = [pendingOf('p1', '  do   the   thing ')]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'do the thing'),
      assistantMessage('m2', 'done')
    ])
    expect(next).toEqual([])
  })

  it('drops an attachment pending send once a prefixed transcript prompt advances', () => {
    const pending = [
      { ...pendingOf('p1', 'what do you see'), imagePaths: ['/Users/me/Downloads/3d.png'] }
    ]
    const next = prunePendingSends(pending, [
      userMessage('m1', '[Image #1] what do you see'),
      assistantMessage('m2', 'an image')
    ])
    expect(next).toEqual([])
  })

  it('keeps a pending send that has not landed yet', () => {
    const pending = [pendingOf('p1', 'not yet')]
    const next = prunePendingSends(pending, [assistantMessage('m1', 'working on it')])
    expect(next).toBe(pending)
  })

  it('does not match an assistant message with the same text', () => {
    const pending = [pendingOf('p1', 'echo me')]
    const next = prunePendingSends(pending, [assistantMessage('m1', 'echo me')])
    expect(next).toBe(pending)
  })

  it('prunes only the matched entry, keeping others', () => {
    const pending = [pendingOf('p1', 'first'), pendingOf('p2', 'second')]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'first'),
      assistantMessage('m2', 'first answer')
    ])
    expect(next).toEqual([pendingOf('p2', 'second')])
  })
})

describe('pendingSendsAsMessages', () => {
  it('maps pending sends to prefixed scrape-source user messages sorted by sentAt', () => {
    const messages = pendingSendsAsMessages([{ id: 'p1', text: 'queued text', sentAt: 42 }])
    expect(messages).toEqual([
      {
        id: 'pending:p1',
        role: 'user',
        blocks: [{ type: 'text', text: 'queued text' }],
        timestamp: 42,
        source: 'scrape'
      }
    ])
  })

  it('includes image refs for pending attachment sends', () => {
    const messages = pendingSendsAsMessages([
      { id: 'p1', text: 'what do you see?', imagePaths: ['/tmp/shot.png'], sentAt: 42 }
    ])
    expect(messages[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/shot.png' },
      { type: 'text', text: 'what do you see?' }
    ])
  })

  it('hides a pending send while its real user turn is visible', () => {
    const pending = [pendingOf('p1', 'first prompt')]

    expect(pendingSendsAsMessages(pending, [userMessage('u1', 'first prompt')])).toEqual([])
    expect(pendingSendsAsMessages(pending, [])).toHaveLength(1)
  })
})

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
        [userMessage('u1', 'Fix failing checks')]
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
      userMessage(
        'u1',
        'Resolve the failing checks: Resolve the failing checks: - lint failed fix spacing'
      ),
      assistantMessage('a1', 'I will fix it')
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

    expect(shouldPruneLaunchPrompt(prompt, [userMessage('u1', 'Fix failing checks')])).toBe(false)
    expect(
      shouldPruneLaunchPrompt(prompt, [
        userMessage('u1', 'Fix failing checks'),
        assistantMessage('a1', 'working')
      ])
    ).toBe(true)
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

  it('clears cached pending sends when pruning removes all entries', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex' }
    appendPendingSendCache(scope, pendingOf('p1', 'first prompt'))

    writePendingSendCache(scope, [])

    expect(readPendingSendCache(scope)).toEqual([])
  })
})

describe('isPendingMessageId', () => {
  it('recognizes the pending id prefix', () => {
    expect(isPendingMessageId('pending:p1')).toBe(true)
    expect(isPendingMessageId('transcript-123')).toBe(false)
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

  it('isCommandMarkerId recognizes the prefix', () => {
    expect(isCommandMarkerId('command:c1')).toBe(true)
    expect(isCommandMarkerId('pending:p1')).toBe(false)
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
  // The per-key arrays were capped at 8, but the KEY count (paneKey/agent/session,
  // all ephemeral) was unbounded, so distinct panes/sessions accumulated forever.
  // Both caches now LRU-bound the key count at 128 (shared helper, #7566).
  const CAP = 128

  it('appendCommandMarkerCache evicts the oldest scope key past the cap', () => {
    clearCommandMarkerCacheForTests()
    for (let i = 0; i < CAP + 5; i++) {
      appendCommandMarkerCache(
        { paneKey: 'tab:leaf', agent: 'claude', sessionId: `s${i}` },
        '/clear'
      )
    }
    // Oldest sessions evicted; the most-recent CAP survive.
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
