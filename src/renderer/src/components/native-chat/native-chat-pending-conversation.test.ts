import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimBootstrapPendingSends,
  clearNativeChatConversationBindingsForTests,
  selectClaimableBootstrapSends
} from './native-chat-pending-conversation'
import {
  appendCommandMarkerCache,
  appendPendingSendCache,
  clearCommandMarkerCacheForTests,
  clearPendingSendCacheForTests,
  readPendingSendCache,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'

const PANE = 'tab-1:leaf-1'
const bootstrapScope: NativeChatPendingSendScope = {
  paneKey: PANE,
  agent: 'codex',
  conversationId: null
}
const scopeOf = (conversationId: string | null, paneKey = PANE): NativeChatPendingSendScope => ({
  paneKey,
  agent: 'codex',
  conversationId
})

function send(id: string, text: string, sentAt: number): NativeChatPendingSend {
  return { id, text, sentAt, afterMessageId: null, afterMessageTimestamp: null }
}

const textsIn = (scope: NativeChatPendingSendScope): string[] =>
  readPendingSendCache(scope).map((entry) => entry.text)

describe('selectClaimableBootstrapSends', () => {
  it('keeps everything when the window recorded no /clear', () => {
    const entries = [send('p1', 'one', 10), send('p2', 'two', 20)]
    expect(selectClaimableBootstrapSends(entries, [])).toEqual(entries)
  })

  it('drops sends at or before the latest /clear and keeps later ones', () => {
    const entries = [
      send('p1', 'before', 10),
      send('p2', 'on the boundary', 30),
      send('p3', 'after', 40)
    ]
    const markers = [
      { id: 'm1', command: '/clear', sentAt: 20 },
      { id: 'm2', command: '/model gpt', sentAt: 35 },
      { id: 'm3', command: '/clear', sentAt: 30 }
    ]

    expect(selectClaimableBootstrapSends(entries, markers).map((entry) => entry.text)).toEqual([
      'after'
    ])
  })

  it('ignores slash commands that do not replace the conversation', () => {
    const entries = [send('p1', 'one', 10)]
    const markers = [{ id: 'm1', command: '/model gpt', sentAt: 20 }]
    expect(selectClaimableBootstrapSends(entries, markers)).toEqual(entries)
  })
})

describe('claimBootstrapPendingSends', () => {
  beforeEach(() => {
    clearPendingSendCacheForTests()
    clearCommandMarkerCacheForTests()
    clearNativeChatConversationBindingsForTests()
  })

  it('hands the pre-identity bucket to the first conversation and empties it', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'first prompt', 10))

    claimBootstrapPendingSends(scopeOf('session-a'), [])

    expect(textsIn(scopeOf('session-a'))).toEqual(['first prompt'])
    expect(readPendingSendCache(bootstrapScope)).toEqual([])
  })

  it('merges into the claiming conversation by send time, keeping its own echoes', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'pre-identity prompt', 10))
    appendPendingSendCache(scopeOf('session-a'), send('p2', 'already scoped prompt', 20))

    claimBootstrapPendingSends(scopeOf('session-a'), [])

    expect(textsIn(scopeOf('session-a'))).toEqual(['pre-identity prompt', 'already scoped prompt'])
  })

  it('closes the bucket for good, so a refill cannot be claimed by a replacement', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'first prompt', 10))
    claimBootstrapPendingSends(scopeOf('session-a'), [])

    // Anything that lands in the pre-identity bucket after the pane is bound is
    // never handed on: adoption is a bootstrap-only event, not a standing rule.
    appendPendingSendCache(bootstrapScope, send('p2', 'stray post-bootstrap echo', 30))
    claimBootstrapPendingSends(scopeOf('session-b'), [])

    expect(readPendingSendCache(scopeOf('session-b'))).toEqual([])
    expect(textsIn(scopeOf('session-a'))).toEqual(['first prompt'])
  })

  it('does not bind the pane while it still has no conversation id', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'first prompt', 10))

    claimBootstrapPendingSends(bootstrapScope, [])
    expect(textsIn(bootstrapScope)).toEqual(['first prompt'])

    claimBootstrapPendingSends(scopeOf('session-a'), [])
    expect(textsIn(scopeOf('session-a'))).toEqual(['first prompt'])
  })

  it('reads the /clear boundary recorded in the same pre-identity window', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'sent before the clear', 10))
    appendCommandMarkerCache({ paneKey: PANE, agent: 'codex', sessionId: null }, '/clear', 20)
    appendPendingSendCache(bootstrapScope, send('p2', 'sent after the clear', 30))
    const markers = [{ id: 'm1', command: '/clear', sentAt: 20 }]

    claimBootstrapPendingSends(scopeOf('session-a'), markers)

    expect(textsIn(scopeOf('session-a'))).toEqual(['sent after the clear'])
    expect(readPendingSendCache(bootstrapScope)).toEqual([])
  })

  it('binds each pane independently', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'left pane prompt', 10))
    appendPendingSendCache(scopeOf(null, 'tab-2:leaf-2'), send('p2', 'right pane prompt', 10))

    claimBootstrapPendingSends(scopeOf('session-a'), [])
    claimBootstrapPendingSends(scopeOf('session-b', 'tab-2:leaf-2'), [])

    expect(textsIn(scopeOf('session-a'))).toEqual(['left pane prompt'])
    expect(textsIn(scopeOf('session-b', 'tab-2:leaf-2'))).toEqual(['right pane prompt'])
  })

  it('binds a pane that reported its conversation before any send', () => {
    claimBootstrapPendingSends(scopeOf('session-a'), [])

    // A pane with no pre-identity window still closes its bucket, so a send that
    // somehow lands there later cannot be adopted by the next conversation.
    appendPendingSendCache(bootstrapScope, send('p1', 'stray echo', 10))
    claimBootstrapPendingSends(scopeOf('session-b'), [])

    expect(readPendingSendCache(scopeOf('session-b'))).toEqual([])
  })

  it('stays closed after many other panes bind', () => {
    appendPendingSendCache(bootstrapScope, send('p1', 'first prompt', 10))
    claimBootstrapPendingSends(scopeOf('session-a'), [])
    appendPendingSendCache(bootstrapScope, send('p2', 'post-bootstrap prompt', 20))

    for (let index = 0; index < 129; index += 1) {
      claimBootstrapPendingSends(scopeOf(`other-${index}`, `other-pane-${index}`), [])
    }
    claimBootstrapPendingSends(scopeOf('session-b'), [])

    expect(textsIn(scopeOf('session-b'))).toEqual([])
  })
})
