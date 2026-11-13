import {
  resolvePendingSendEvidence,
  rejectPendingSend
} from './native-chat-optimistic-send-outcome'
import {
  launchPromptAsMessage,
  shouldPruneLaunchPrompt
} from '../../../drafts/native-chat-launch-prompt'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  prunePendingSends,
  visibleNativeChatPendingSends,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  readPendingSendCache,
  writePendingSendCache,
  observePendingSendCache
} from './native-chat-pending'

const scope = { paneKey: 'test', agent: 'opencode' }
const session = 'session'
const full = 'one\ntwo\nthree'
const caption = '  one\ntwo\nthree  '
function row(text: string, id: string, transcriptOrder = 1): NativeChatMessage {
  return {
    id,
    role: 'user',
    source: 'transcript',
    timestamp: null,
    transcriptOrder,
    blocks: [{ type: 'text', text }],
    inputContent: {
      provider: 'opencode',
      textDigest: createHash('sha256').update(text).digest('hex'),
      images: []
    }
  }
}
const answer: NativeChatMessage = {
  id: 'answer',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  transcriptOrder: 9,
  blocks: []
}
function send(id: string, text: string, imagePaths?: string[]): NativeChatPendingSend {
  return { id, text, imagePaths, sourceAgent: 'opencode', sentAt: 1, afterMessageId: 'missing' }
}
beforeEach(() => clearPendingSendCacheForTests())

it('retains recoverable input through observation churn and keeps surviving frontiers useful', () => {
  appendPendingSendCache(scope, { ...send('parked', 'original'), delivery: 'unconfirmed' })
  for (let index = 0; index < 256; index++) {
    observePendingSendCache(
      { paneKey: `observed-${index}`, agent: 'opencode' },
      [{ ...answer, id: `frontier-${index}` }],
      session
    )
  }
  expect(readPendingSendCache(scope).map((entry) => entry.text)).toEqual(['original'])
  const recent = { paneKey: 'observed-255', agent: 'opencode' }
  expect(appendPendingSendCache(recent, send('new', 'next'), session)[0].sourceBoundary?.id).toBe(
    'frontier-255'
  )
  const evicted = { paneKey: 'observed-0', agent: 'opencode' }
  expect(appendPendingSendCache(evicted, send('unknown', 'next'), session)[0].sourceBoundary).toBe(
    undefined
  )
  writePendingSendCache(scope, [])
  observePendingSendCache(scope, [answer], session)
  expect(appendPendingSendCache(scope, send('again', 'next'), session)[0].sourceBoundary?.id).toBe(
    'answer'
  )
})

it('does not promote pending owners on observation or evict them for new empty scopes', () => {
  for (let index = 0; index < 128; index++) {
    appendPendingSendCache(
      { paneKey: `pending-${index}`, agent: 'opencode' },
      send(`send-${index}`, 'original')
    )
  }
  const oldest = { paneKey: 'pending-0', agent: 'opencode' }
  observePendingSendCache(oldest, [answer], session)
  observePendingSendCache({ paneKey: 'empty', agent: 'opencode' }, [answer], session)
  expect(readPendingSendCache(oldest).map((entry) => entry.id)).toEqual(['send-0'])
  appendPendingSendCache({ paneKey: 'new-pending', agent: 'opencode' }, send('new', 'next'))
  expect(readPendingSendCache(oldest)).toEqual([])
  expect(readPendingSendCache({ paneKey: 'pending-1', agent: 'opencode' })[0].id).toBe('send-1')
})

it('holds a pathless image receipt through cache remount and paging without reclaiming it', () => {
  const pending = ['first', 'second'].map((id) => ({
    id,
    text: '',
    imagePaths: [`/tmp/${id}.png`],
    sentAt: 100,
    afterMessageId: 'working'
  }))
  const working = { ...answer, id: 'working', timestamp: 90, transcriptOrder: 0 }
  const image: NativeChatMessage = {
    id: 'image',
    role: 'user',
    timestamp: 110,
    transcriptOrder: 1,
    source: 'transcript',
    blocks: [{ type: 'image-ref', url: 'data:image/png;base64,iVBORw0K' }]
  }
  const landed = [working, image]
  writePendingSendCache(scope, prunePendingSends(pending, landed, session))
  const remounted = readPendingSendCache(scope)
  expect(remounted.map((entry) => entry.id)).toEqual(['first', 'second'])
  expect(prunePendingSends(remounted, landed, session)).toBe(remounted)
  expect(prunePendingSends(remounted, [], session)).toBe(remounted)
  expect(visibleNativeChatPendingSends(remounted, [], session).map((entry) => entry.id)).toEqual([
    'second'
  ])
  const replied = [...landed, { ...answer, timestamp: 120 }]
  writePendingSendCache(scope, prunePendingSends(remounted, replied, session))
  const remaining = readPendingSendCache(scope)
  expect(remaining.map((entry) => entry.id)).toEqual(['second'])
  expect(
    visibleNativeChatPendingSends(remaining, replied, session).map((entry) => entry.id)
  ).toEqual(['second'])
  expect(
    prunePendingSends(
      remaining,
      [
        ...replied,
        { ...image, id: 'new-image', timestamp: 130, transcriptOrder: 10 },
        { ...answer, id: 'later-answer', timestamp: 140, transcriptOrder: 11 }
      ],
      session
    )
  ).toEqual([])
})

it('replaces failed legacy captions without merging different source requests or image-only paths', () => {
  const legacy = { id: 'old', text: 'look', imagePaths: ['/tmp/a.png'], sentAt: 1 }
  appendPendingSendCache(scope, { ...legacy, delivery: 'rejected' })
  appendPendingSendCache(scope, { ...legacy, id: 'live', text: 'neighbor' })
  expect(
    appendPendingSendCache(scope, { ...legacy, id: 'new', imagePaths: ['/tmp/b.png'] }).map(
      (entry) => entry.id
    )
  ).toEqual(['live', 'new'])
  writePendingSendCache(scope, [{ ...send('source', '  look  '), delivery: 'rejected' }])
  expect(appendPendingSendCache(scope, legacy).map((entry) => entry.id)).toEqual(['source', 'old'])
  expect(
    appendPendingSendCache(scope, { ...legacy, id: 'raw', text: '  look  ', imagePaths: [] }).map(
      (entry) => entry.id
    )
  ).toEqual(['old', 'raw'])
  writePendingSendCache(scope, [{ ...legacy, text: '', delivery: 'rejected' }])
  expect(
    appendPendingSendCache(scope, {
      ...legacy,
      id: 'different',
      text: '',
      imagePaths: ['/tmp/b.png']
    }).map((entry) => entry.id)
  ).toEqual(['old', 'different'])
  expect(
    appendPendingSendCache(scope, { ...legacy, id: 'same', text: '' }).map((entry) => entry.id)
  ).toEqual(['different', 'same'])
})

it.each([false, true])(
  'keeps text and compound image fallback in chronological order, image first: %s',
  (imageFirst) => {
    const source = send('source', 'a b')
    const group = [
      { ...send('image', 'a b', ['/tmp/a.png']), sourceAgent: undefined },
      { ...send('a', 'a'), sourceAgent: undefined },
      { ...send('b', 'b'), sourceAgent: undefined }
    ]
    const pending = imageFirst ? [...group, source] : [source, ...group]
    const messages = [row('a b', 'x'), answer]
    const remaining = prunePendingSends(pending, messages, session)
    expect(remaining.map((entry) => entry.id)).toEqual(
      imageFirst ? ['source'] : ['image', 'a', 'b']
    )
    writePendingSendCache(scope, remaining)
    expect(
      visibleNativeChatPendingSends(readPendingSendCache(scope), messages, session).map(
        (entry) => entry.id
      )
    ).toEqual(imageFirst ? ['source'] : ['image', 'a', 'b'])
    expect(
      prunePendingSends(
        readPendingSendCache(scope),
        [...messages, row('a b', 'y', 10), { ...answer, id: 'later-answer', transcriptOrder: 11 }],
        session
      )
    ).toEqual([])
    expect(
      prunePendingSends([{ ...source, text: 'a  b' }, group[0]], messages, session).map(
        (entry) => entry.id
      )
    ).toEqual(['image'])
  }
)

it.each([
  { survivor: 'a', keepImage: false, expected: ['a'] },
  { survivor: 'b', keepImage: false, expected: ['b'] },
  { survivor: 'b', keepImage: true, expected: ['image', 'b'] }
])(
  'retains compound advance windows through partial retirement and remount: %j',
  ({ survivor, keepImage, expected }) => {
    const image = {
      ...send('image', 'a b', ['/tmp/a.png']),
      sourceAgent: undefined,
      afterMessageId: keepImage ? null : undefined,
      afterMessageTimestamp: keepImage ? 1600 : undefined
    }
    const a = {
      ...send('a', 'a'),
      sourceAgent: undefined,
      afterMessageId: undefined,
      sentAt: survivor === 'a' ? 2000 : 1000
    }
    const b = {
      ...send('b', 'b'),
      sourceAgent: undefined,
      afterMessageId: undefined,
      sentAt: survivor === 'b' ? 2000 : 1000
    }
    const x = { ...row('a b', 'x'), timestamp: 2001 }
    const early = { ...answer, timestamp: 1500 }
    const remaining = prunePendingSends([image, a, b], [x, early], session)
    expect(remaining.map((entry) => entry.id)).toEqual(expected)
    writePendingSendCache(scope, remaining)
    const remounted = readPendingSendCache(scope)
    expect(visibleNativeChatPendingSends(remounted, [], session)).toEqual([])
    expect(prunePendingSends(remounted, [x, early], session).map((entry) => entry.id)).toEqual(
      expected
    )
    expect(
      prunePendingSends(remounted, [x, early, { ...answer, id: 'later', timestamp: 2002 }], session)
    ).toEqual([])
  }
)

it('keeps a spent overlapping source unit excluded through pruning, cache remount and paging', () => {
  appendPendingSendCache(scope, send('plain', full))
  const pending = appendPendingSendCache(scope, send('padded', caption))
  const receipt = row(full, 'shared')
  expect(
    visibleNativeChatPendingSends(pending, [receipt], session).map((entry) => entry.id)
  ).toEqual(['padded'])
  writePendingSendCache(scope, prunePendingSends(pending, [receipt, answer], session))
  const remounted = readPendingSendCache(scope)
  expect(remounted.map((entry) => entry.id)).toEqual(['padded'])
  expect(prunePendingSends(remounted, [], session)).toBe(remounted)
  expect(
    visibleNativeChatPendingSends(remounted, [receipt, answer], session).map((entry) => entry.id)
  ).toEqual(['padded'])
  expect(prunePendingSends(remounted, [receipt, row(full, 'new', 2), answer], session)).toEqual([])
  // An earlier unspent row first loaded later remains usable; the survivor's boundary was not advanced.
  expect(
    prunePendingSends(
      remounted,
      [row('  one\ntwo\nthree  ', 'earlier', 0), receipt, answer],
      session
    )
  ).toEqual([])
})

it('preserves distinct recoverable requests and skips incompatible receipts before allocating', () => {
  const padded = send('padded', `  ${'x'.repeat(160)}  `)
  appendPendingSendCache(scope, { ...padded, delivery: 'rejected' })
  const plain = send('plain', 'x'.repeat(160))
  const pending = appendPendingSendCache(scope, plain)
  expect(pending.map((entry) => entry.id)).toEqual(['padded', 'plain'])
  expect(
    prunePendingSends(
      pending,
      [row('foreign', 'foreign'), row('x'.repeat(160), 'plain-row'), answer],
      session
    ).map((entry) => entry.id)
  ).toEqual(['padded'])
  const replacement = appendPendingSendCache(scope, { ...padded, id: 'resend' })
  expect(replacement.map((entry) => entry.id)).toEqual(['plain', 'resend'])
})

it('maximizes compatible assignments without allowing legacy fallback to reuse a source unit', () => {
  const first = send('flexible', '  one\ntwo\nthree  ')
  const second = send('exact', 'one\ntwo\nthree')
  expect(
    prunePendingSends(
      [first, second],
      [row('one\ntwo\nthree', 'x'), row('  one\ntwo\nthree  ', 'y', 2), answer],
      session
    )
  ).toEqual([])
  const legacy = { ...send('legacy', 'one\ntwo\nthree'), sourceAgent: undefined }
  const pending = [legacy, first]
  expect(
    visibleNativeChatPendingSends(pending, [row('one\ntwo\nthree', 'x'), answer], session).map(
      (entry) => entry.id
    )
  ).toEqual(['flexible'])
  writePendingSendCache(
    scope,
    prunePendingSends(pending, [row('one\ntwo\nthree', 'x'), answer], session)
  )
  const survivor = readPendingSendCache(scope)
  expect(
    visibleNativeChatPendingSends(survivor, [row('one\ntwo\nthree', 'x'), answer], session).map(
      (entry) => entry.id
    )
  ).toEqual(['flexible'])
})

it('keeps main fallback available after cached source-frontier observation and session replacement', () => {
  const old = row('repeat', 'old', 1)
  observePendingSendCache(scope, [old, answer], session)
  writePendingSendCache(scope, [])
  observePendingSendCache(scope, [], session)
  observePendingSendCache(scope, [old], session)
  const pending = appendPendingSendCache(scope, send('later', 'repeat'))
  expect(prunePendingSends(pending, [old, answer], session)).toEqual([])
  expect(
    prunePendingSends(
      pending,
      [
        old,
        answer,
        row('repeat', 'new', 10),
        { ...answer, id: 'later-answer', transcriptOrder: 11 }
      ],
      session
    )
  ).toEqual([])
  observePendingSendCache(scope, [], 'replacement-session')
  expect(
    prunePendingSends(pending, [row('repeat', 'new', 0), answer], 'replacement-session')
  ).toEqual([])
})

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

it('assigns competing source and legacy witnesses by send age and uses alternative rows jointly', () => {
  const source = send('source', 'first second')
  const legacy = { ...send('legacy', 'first second'), sourceAgent: undefined }
  const x = row('first second', 'x')
  const y = row('first second', 'y', 2)
  const visible = (entries: NativeChatPendingSend[], rows = [x]) =>
    visibleNativeChatPendingSends(entries, rows, session).map((entry) => entry.id)
  expect(visible([source, legacy])).toEqual(['legacy'])
  expect(visible([legacy, source])).toEqual(['source'])
  expect(visible([source, legacy], [x, y])).toEqual([])
  const group = [
    { ...legacy, id: 'first', text: 'first' },
    { ...legacy, id: 'second', text: 'second' }
  ]
  expect(visible([source, ...group])).toEqual(['first', 'second'])
  expect(visible([...group, source])).toEqual(['source'])
  expect(visible([source, ...group], [x, y])).toEqual([])
  // The older owner keeps the earliest receipt rather than moving behind an unadvanced later one.
  expect(
    prunePendingSends([source, { ...source, id: 'later' }], [x, answer, y], session).map(
      (entry) => entry.id
    )
  ).toEqual(['later'])
})

it('keeps committed groups owned when only some members advance or the row pages out', () => {
  const a = { ...send('a', 'first'), sourceAgent: undefined, afterMessageId: null, sentAt: 1000 }
  const b = { ...a, id: 'b', text: 'second', sentAt: 2000 }
  const x = { ...row('first second', 'x'), timestamp: 2001 }
  const early = { ...answer, timestamp: 1500 }
  const kept = prunePendingSends([a, b], [x, early], session)
  expect(kept.map((entry) => entry.id)).toEqual(['b'])
  expect(visibleNativeChatPendingSends(kept, [], session)).toEqual([])
  expect(prunePendingSends(kept, [x, early], session).map((entry) => entry.id)).toEqual(['b'])
  expect(prunePendingSends(kept, [x, { ...answer, timestamp: 2002 }], session)).toEqual([])
})

it('qualifies advancement with the same timestamp window as its source receipt', () => {
  const entry = { ...send('later', 'repeat'), afterMessageTimestamp: 1000 }
  const receipt = { ...row('repeat', 'x'), timestamp: 1001 }
  const early = { ...answer, timestamp: 999 }
  expect(visibleNativeChatPendingSends([entry], [receipt, early], session)).toEqual([])
  const kept = prunePendingSends([entry], [receipt, early], session)
  expect(kept.map((entry) => entry.id)).toEqual(['later'])
  expect(
    prunePendingSends(
      kept,
      [receipt, early, { ...answer, id: 'new-answer', timestamp: 1002 }],
      session
    )
  ).toEqual([])
})

it.each([5000, 50000])(
  'observes a position-less append in suffix-sized work at %i rows',
  (size) => {
    let reads = 0
    const history = Array.from({ length: size }, (_, index) => ({
      ...row('old', `old-${index}`),
      transcriptOrder: undefined,
      get id() {
        reads++
        return `old-${index}`
      }
    }))
    observePendingSendCache(scope, history, session)
    reads = 0
    const next = { ...answer, id: 'frontier', transcriptOrder: undefined }
    observePendingSendCache(scope, [...history, next], session)
    // An append needs only its suffix and the preceding frontier, independent of loaded history.
    expect(reads).toBeLessThanOrEqual(2)
    reads = 0
    observePendingSendCache(scope, [...history, next], session)
    expect(reads).toBe(0)
    observePendingSendCache(scope, [], session)
    observePendingSendCache(scope, [history[0]], session)
    observePendingSendCache(scope, [{ ...next, id: 'disjoint' }], session)
    const [entry] = appendPendingSendCache(scope, send('new-send', 'old'))
    expect(entry.sourceBoundary?.id).toBe('frontier')
  }
)

it('keeps rejected Codex originals out of receipt rank and preserves prospective exclusions for unresolved siblings', () => {
  const rejected: NativeChatPendingSend = {
    ...send('rejected', 'repeat '),
    sourceAgent: 'codex',
    delivery: 'rejected'
  }
  const accepted: NativeChatPendingSend = { ...send('accepted', 'repeat'), sourceAgent: 'codex' }
  const receipt = {
    ...row('repeat', 'receipt'),
    inputContent: {
      provider: 'codex' as const,
      textDigest: createHash('sha256').update('repeat').digest('hex'),
      images: []
    }
  }
  const messages = [receipt, answer]
  expect(
    prunePendingSends([rejected, accepted], messages, session).map((entry) => [
      entry.id,
      entry.text
    ])
  ).toEqual([['rejected', 'repeat ']])
  const unresolved: NativeChatPendingSend = {
    ...rejected,
    id: 'unresolved',
    delivery: undefined,
    dispatchPending: true
  }
  const retained = prunePendingSends([accepted, unresolved], messages, session)
  expect(retained.map((entry) => entry.id)).toEqual(['unresolved'])
  const resolved = retained.map((entry) => ({ ...entry, dispatchPending: undefined }))
  expect(prunePendingSends(resolved, messages, session).map((entry) => entry.id)).toEqual([
    'unresolved'
  ])
  expect(
    prunePendingSends(
      resolved,
      [
        ...messages,
        { ...receipt, id: 'new-receipt', transcriptOrder: 10 },
        { ...answer, id: 'new-answer', transcriptOrder: 11 }
      ],
      session
    )
  ).toEqual([])
})

it('releases each failed legacy predecessor once when the live transport falls back', () => {
  const first: NativeChatPendingSend = { ...send('first', 'a  b  '), evidenceModePending: true }
  const second: NativeChatPendingSend = { ...send('second', 'a b '), evidenceModePending: true }
  const successor: NativeChatPendingSend = {
    ...send('successor', 'a b'),
    evidenceModePending: true
  }
  appendPendingSendCache(scope, first)
  appendPendingSendCache(scope, second)
  let pending = appendPendingSendCache(scope, successor)
  pending = resolvePendingSendEvidence(pending, first.id, 'opencode', false)
  pending = resolvePendingSendEvidence(pending, second.id, 'opencode', false)
  pending = rejectPendingSend(pending, first.id)
  pending = rejectPendingSend(pending, second.id)
  pending = resolvePendingSendEvidence(pending, successor.id, 'opencode', false)
  expect(pending.map((entry) => entry.id)).toEqual(['successor'])
  expect(prunePendingSends(pending, [row('a b', 'delivered'), answer], session)).toEqual([])
})

it('keeps a late claimed occurrence spent when a failed predecessor leaves fallback', () => {
  const first: NativeChatPendingSend = { ...send('first', 'a  b'), evidenceModePending: true }
  const successor: NativeChatPendingSend = {
    ...send('successor', 'a b'),
    evidenceModePending: true
  }
  appendPendingSendCache(scope, first)
  let pending = appendPendingSendCache(scope, successor)
  pending = resolvePendingSendEvidence(pending, first.id, 'opencode', false)
  pending = pending.map((entry) =>
    entry.id === first.id ? { ...entry, delivery: 'unconfirmed' as const } : entry
  )
  const received = row('a b', 'first-row')
  pending = prunePendingSends(pending, [received], session)
  expect(pending[0].sourceReceipt?.id).toBe('first-row')
  pending = resolvePendingSendEvidence(pending, successor.id, 'opencode', false)
  expect(pending.map((entry) => entry.id)).toEqual(['successor'])
  pending = prunePendingSends(pending, [received, answer], session)
  expect(pending.map((entry) => entry.id)).toEqual(['successor'])
  expect(
    prunePendingSends(
      pending,
      [
        received,
        answer,
        row('a b', 'second-row', 10),
        { ...answer, id: 'second-answer', transcriptOrder: 11 }
      ],
      session
    )
  ).toEqual([])
})
