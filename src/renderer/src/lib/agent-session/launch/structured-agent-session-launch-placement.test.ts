// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { StoredNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'

// The launch tab lookup is the only stand-in: the move, the draft store and its positions run for real.
vi.mock('./structured-agent-session-launch-surface', () => ({
  findStructuredLaunchTab: () => undefined
}))

const { moveStructuredAgentLaunchDraft } = await import('./structured-agent-session-launch-draft')
const {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} = await import('@/components/native-chat/drafts/native-chat-composer-draft-store')
const { clearDraftMemoryForTests, load, nativeChatDraftPositions, records } =
  await import('@/components/native-chat/drafts/native-chat-composer-draft-memory')
const { structuredAgentSessionDraftScopeKey } =
  await import('@/components/native-chat/drafts/native-chat-draft-scope')

const positionOf = (scope: string) => {
  const record = records.get(scope)
  return record && nativeChatDraftPositions.get(record)
}
const spanOf = (position: ReturnType<typeof positionOf>): { from: number; to: number } => {
  expect(position?.at).toBe('selection')
  return position?.at === 'selection' ? position : { from: -1, to: -1 }
}

/** Move a launch draft of `moved` (with `selection`) into a chat whose draft holds `held`. */
const move = (
  name: string,
  held: string,
  moved: { text: string; images?: readonly { id: string; path: string }[] },
  selection?: { from: number; to: number }
) => {
  const sessionId = `placement-${name}`
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const source = `pending-creation:placement-${name}`
  if (held) {
    updateNativeChatComposerDraft(scope, { text: held }, 'immediate')
  }
  updateNativeChatComposerDraft(
    source,
    { text: moved.text, images: [...(moved.images ?? [])] },
    'immediate'
  )
  moveStructuredAgentLaunchDraft(
    { sessionId, worktreeId: 'wt', executionHostId: 'local' },
    source,
    selection
  )
  return { scope, merged: readNativeChatComposerDraft(scope).text, position: positionOf(scope) }
}

// The moved selection lands inside the span the moved text occupies in the merged draft, clamped to it.
it('places the moved selection inside the moved text span', () => {
  const placed = move('appended', 'mine', { text: 'hello world' }, { from: 6, to: 11 })
  expect(placed.position).toMatchObject({ at: 'selection', pending: true })
  const { from, to } = spanOf(placed.position)
  expect(placed.merged.slice(from, to)).toBe('world')

  const clamped = move('clamped', 'mine', { text: 'hi' }, { from: 0, to: 99 })
  expect(clamped.position).toMatchObject({ at: 'selection', to: clamped.merged.length })
})

// A move with no span of its own in the merged text (whitespace-only, a trimmed duplicate the chat
// already holds, or image-only) puts the caret at the end, never at the start of the chat's own text.
it('puts the caret at the end when the moved text has no surviving span', () => {
  for (const [name, held, moved] of [
    ['blank', 'mine', { text: '   ' }],
    ['duplicate', 'x\n\nhello', { text: 'hello\n' }],
    ['image-only', 'mine', { text: '', images: [{ id: 'only', path: 'blob:placement-only' }] }]
  ] as const) {
    const placed = move(name, held, moved, { from: 1, to: 2 })
    expect(placed.position, name).toMatchObject({ at: 'end', pending: true })
  }
})

// A refusal handed back after the move appends to the text but keeps it as its prefix: the move's still
// pending caret stays where it was, within the old text; an end caret stays at the old text's end.
it('carries a still-pending placement through an append that keeps the old text', () => {
  const placed = move('carried', 'mine', { text: 'hello world' }, { from: 6, to: 11 })
  const { from, to } = spanOf(placed.position)
  appendToNativeChatComposerDraft(placed.scope, { text: 'refused message' })
  expect(readNativeChatComposerDraft(placed.scope).text).toContain('refused message')
  expect(positionOf(placed.scope)).toMatchObject({ at: 'selection', from, to, pending: true })

  const atEnd = move('carried-end', 'mine  ', { text: '', images: [{ id: 'i', path: 'blob:end' }] })
  expect(atEnd.position).toMatchObject({ at: 'end', pending: true })
  appendToNativeChatComposerDraft(atEnd.scope, { text: 'refused' })
  expect(positionOf(atEnd.scope)).toMatchObject({ at: 'selection', from: 4, to: 4, pending: true })
})

// Nothing is carried once the caret is no longer pending, or when the append replaced the text.
it('carries nothing for a settled placement or a replacing append', () => {
  const settled = move('settled', 'mine', { text: 'hello' }, { from: 0, to: 5 })
  settled.position!.pending = false
  appendToNativeChatComposerDraft(settled.scope, { text: 'refused' })
  expect(positionOf(settled.scope)).toBeUndefined()

  const replaced = move('replaced', '', { text: '/compact' }, { from: 0, to: 8 })
  expect(replaced.merged).toBe('/compact')
  appendToNativeChatComposerDraft(replaced.scope, { text: 'refused' })
  expect(readNativeChatComposerDraft(replaced.scope).text).toBe('refused')
  expect(positionOf(replaced.scope)).toBeUndefined()

  // A blank draft is replaced too, even by returned text that starts with blank lines.
  const blank = structuredAgentSessionDraftScopeKey('placement-blank-replaced')
  updateNativeChatComposerDraft(blank, { text: '  ' }, 'immediate', undefined, {
    at: 'end',
    pending: true
  })
  appendToNativeChatComposerDraft(blank, { text: '\n\nrefused' })
  expect(readNativeChatComposerDraft(blank).text).toBe('\n\nrefused')
  expect(positionOf(blank)).toBeUndefined()
})

// The merge decides what is a replace, and the carry follows that same rule: returned text that begins
// with the lone command it replaces (`/compact` → `/compact\n\ncontext`) is a replace, not an append,
// so the command's old placement is not carried into the replacement.
it('carries nothing through a replace that begins with the replaced command', () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-command-prefix')
  updateNativeChatComposerDraft(scope, { text: '/compact' }, 'immediate', undefined, {
    at: 'end',
    pending: true
  })
  appendToNativeChatComposerDraft(scope, { text: '/compact\n\ncontext' })
  expect(readNativeChatComposerDraft(scope).text).toBe('/compact\n\ncontext')
  expect(positionOf(scope)).toBeUndefined()
})

// Before saved drafts load, the move and the later refusal are replayed over the loaded draft; the
// replayed refusal keeps the move's still-pending placement, as the immediate write did.
it('keeps a carried placement when the appends replay over a later-loaded draft', () => {
  // Saved drafts have not loaded yet, and this chat draft was never edited here, so its appends
  // replay over whatever loads.
  clearDraftMemoryForTests()
  const placed = move('replayed', '', { text: 'hello world' }, { from: 6, to: 11 })
  appendToNativeChatComposerDraft(placed.scope, { text: 'refused message' })
  const replays = load.appendsBeforeLoad.get(placed.scope) ?? []
  expect(replays.length).toBeGreaterThanOrEqual(2)

  const saved: StoredNativeChatComposerDraft = { text: 'saved earlier', images: [], savedAt: 0 }
  const replayed = replays.reduce<StoredNativeChatComposerDraft>(
    (draft, entry) => entry.append(draft),
    saved
  )
  const { from, to } = spanOf(nativeChatDraftPositions.get(replayed))
  expect(replayed.text.slice(from, to)).toBe('world')
  expect(nativeChatDraftPositions.get(replayed)?.pending).toBe(true)
})

// A move with no content (no text, no images) places nothing: the chat's own pending placement stays.
it('leaves the chat placement untouched when the moved draft is empty', () => {
  const sessionId = 'placement-empty-move'
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const own = { at: 'selection' as const, from: 1, to: 3, pending: true }
  updateNativeChatComposerDraft(scope, { text: 'mine' }, 'immediate', undefined, own)
  moveStructuredAgentLaunchDraft(
    { sessionId, worktreeId: 'wt', executionHostId: 'local' },
    'pending-creation:placement-empty-move',
    { from: 0, to: 0 }
  )
  expect(positionOf(scope)).toBe(own)
  expect(own.pending).toBe(true)
})

const { createMemoryNativeChatComposerDraftStorage, setNativeChatComposerDraftStorageForTests } =
  await import('@/components/native-chat/drafts/native-chat-composer-draft-storage')
const { clearNativeChatComposerDraftsForTests } =
  await import('@/components/native-chat/drafts/native-chat-draft-reset')
const { hydrateNativeChatComposerDrafts } =
  await import('@/components/native-chat/drafts/native-chat-composer-draft-load')

/** Saved drafts have not loaded yet; `scope` has `saved` waiting in storage. */
const beforeLoad = (scope: string, saved: StoredNativeChatComposerDraft) => {
  clearNativeChatComposerDraftsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope, saved)
  setNativeChatComposerDraftStorageForTests(storage)
  return storage
}
const savedEarlier: StoredNativeChatComposerDraft = {
  text: 'saved earlier',
  images: [],
  savedAt: 1
}

// Hydration may move a placement but never create or revive one. An image-only refusal after the move
// changes no text: the replay keeps the move's pending placement through that step, rebased onto the
// draft that loaded.
it('keeps a pending placement through an image-only replay step onto the loaded draft', async () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-image-replay')
  beforeLoad(scope, savedEarlier)
  move('image-replay', '', { text: 'hello world' }, { from: 6, to: 11 })
  appendToNativeChatComposerDraft(scope, { images: [{ id: 'late', path: 'blob:late' }] })

  await hydrateNativeChatComposerDrafts()

  const loaded = readNativeChatComposerDraft(scope)
  expect(loaded.text).toBe('saved earlier\n\nhello world')
  expect(loaded.images.map(({ id }) => id)).toEqual(['late'])
  const { from, to } = spanOf(positionOf(scope))
  expect(loaded.text.slice(from, to)).toBe('world')
  expect(positionOf(scope)?.pending).toBe(true)
})

// Once the editor applied the move's placement, the replay over the loaded draft does not arm it again.
it('does not revive a placement the editor already applied when the drafts load', async () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-applied-replay')
  beforeLoad(scope, savedEarlier)
  const placed = move('applied-replay', '', { text: 'hello world' }, { from: 6, to: 11 })
  placed.position!.pending = false

  await hydrateNativeChatComposerDrafts()

  expect(readNativeChatComposerDraft(scope).text).toBe('saved earlier\n\nhello world')
  expect(positionOf(scope)?.pending ?? false).toBe(false)
})

/** Wait until every pre-load append for `scope` is in storage: the load then reads the move itself. */
const committed = async (scope: string): Promise<void> => {
  await vi.waitFor(() =>
    expect((load.appendsBeforeLoad.get(scope) ?? []).every((entry) => entry.committed)).toBe(true)
  )
}

/**
 * Like `beforeLoad`, but the load's read waits for `release`. The move's own write starts the load, so
 * without the hold it lands before anything after the move (an editor applying the caret, a later
 * image step) can happen first.
 */
const beforeHeldLoad = (scope: string, saved: StoredNativeChatComposerDraft) => {
  const storage = beforeLoad(scope, saved)
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const loadAll = storage.loadAll
  storage.loadAll = async () => {
    await held
    return loadAll()
  }
  return { release: () => release() }
}

/**
 * Like `beforeHeldLoad`, but the first read fails, so the load is tried again later. That retry begins
 * reading only after the move's write, so it reads that write committed: nothing is left to replay, and
 * the placement must come from what the write itself recorded. Resolves once the retry is reading.
 */
const beforeRetriedLoad = (scope: string, saved: StoredNativeChatComposerDraft) => {
  const storage = beforeLoad(scope, saved)
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  const loadAll = storage.loadAll
  storage.loadAll = async () => {
    reads += 1
    if (reads === 1) {
      throw new Error('first read fails')
    }
    await held
    return loadAll()
  }
  return {
    release: () => release(),
    retried: () => vi.waitFor(() => expect(reads).toBe(2), { timeout: 5_000 })
  }
}

// D11-05 / C15-05. A load that already read the committed move has nothing to replay. The live
// placement still stands, rebased past the stored prefix: no cold-start placement replaces it.
it('keeps a pending placement when the load already holds the committed move', async () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-committed-pending')
  const { release } = beforeHeldLoad(scope, savedEarlier)
  move('committed-pending', '', { text: 'hello world' }, { from: 6, to: 11 })
  await committed(scope)

  release()
  await hydrateNativeChatComposerDrafts()

  const loaded = readNativeChatComposerDraft(scope)
  expect(loaded.text).toBe('saved earlier\n\nhello world')
  const { from, to } = spanOf(positionOf(scope))
  expect(loaded.text.slice(from, to)).toBe('world')
  expect(positionOf(scope)?.pending).toBe(true)
})

// The same committed read after the editor applied the placement: nothing is armed again.
it('does not rearm an applied placement when the load already holds the committed move', async () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-committed-applied')
  const { release } = beforeHeldLoad(scope, savedEarlier)
  const placed = move('committed-applied', '', { text: 'hello world' }, { from: 6, to: 11 })
  await committed(scope)
  expect(positionOf(scope)).toBe(placed.position)
  placed.position!.pending = false

  release()
  await hydrateNativeChatComposerDrafts()

  expect(readNativeChatComposerDraft(scope).text).toBe('saved earlier\n\nhello world')
  expect(positionOf(scope)?.pending ?? false).toBe(false)
})

// A mixed read: the move is committed, a later image-only step is not. The replay has no placement to
// carry (the stored record has none), so the live pending one stands, rebased; an applied one doesn't.
it.each([true, false])(
  'keeps a live placement through a committed prefix and image-only suffix (pending %s)',
  async (pending) => {
    const scope = structuredAgentSessionDraftScopeKey(`placement-mixed-${pending}`)
    const { release } = beforeHeldLoad(scope, savedEarlier)
    const placed = move(`mixed-${pending}`, '', { text: 'hello world' }, { from: 6, to: 11 })
    await committed(scope)
    expect(positionOf(scope)).toBe(placed.position)
    placed.position!.pending = pending
    appendToNativeChatComposerDraft(scope, { images: [{ id: 'late', path: 'blob:late' }] })

    release()
    await hydrateNativeChatComposerDrafts()

    const loaded = readNativeChatComposerDraft(scope)
    expect(loaded.text).toBe('saved earlier\n\nhello world')
    expect(loaded.images.map(({ id }) => id)).toEqual(['late'])
    if (pending) {
      const { from, to } = spanOf(positionOf(scope))
      expect(loaded.text.slice(from, to)).toBe('world')
      expect(positionOf(scope)?.pending).toBe(true)
    } else {
      expect(positionOf(scope)?.pending ?? false).toBe(false)
    }
  }
)

// The cold-start control: a draft this run never touched opens at its start, as before.
it('opens a draft nothing placed this run at its start', async () => {
  const scope = structuredAgentSessionDraftScopeKey('placement-cold-start')
  beforeLoad(scope, savedEarlier)

  await hydrateNativeChatComposerDrafts()

  expect(readNativeChatComposerDraft(scope).text).toBe('saved earlier')
  expect(positionOf(scope)).toEqual({ at: 'start', pending: true })
})

// D12-06 / C16-06. The same loaded bytes, two histories: the chat had "hello world" saved and the move
// added "hello" after it, or nothing was saved and the move brought all of it. Each placement lands
// where its own write put it, never where matching text first happens to occur.
it.each([
  ['moved after a saved prefix', 'hello world', 'hello', { from: 0, to: 5 }, { from: 13, to: 18 }],
  ['moved whole', '', 'hello world\n\nhello', { from: 0, to: 5 }, { from: 0, to: 5 }]
] as const)(
  'places a committed move where its write put it when it is %s',
  async (name, saved, movedText, selection, expected) => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = structuredAgentSessionDraftScopeKey(`placement-lineage-${name}`)
    const { release, retried } = beforeRetriedLoad(scope, { text: saved, images: [], savedAt: 1 })
    move(`lineage-${name}`, '', { text: movedText }, selection)
    await committed(scope)
    await retried()

    release()
    await hydrateNativeChatComposerDrafts()
    quiet.mockRestore()

    expect(readNativeChatComposerDraft(scope).text).toBe('hello world\n\nhello')
    expect(spanOf(positionOf(scope))).toMatchObject(expected)
    expect(positionOf(scope)?.pending).toBe(true)
  }
)

// A placement this run made and a later replacing step retired is not a cold start: the loaded draft
// gets no placement, rather than one armed at its start.
it('arms nothing for a placement a replacing step retired before the load', async () => {
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const scope = structuredAgentSessionDraftScopeKey('placement-lineage-retired')
  const { release, retried } = beforeRetriedLoad(scope, savedEarlier)
  move('lineage-retired', '', { text: '/compact' }, { from: 0, to: 8 })
  appendToNativeChatComposerDraft(scope, { text: 'refused' })
  expect(positionOf(scope)).toBeUndefined()
  await committed(scope)
  await retried()

  release()
  await hydrateNativeChatComposerDrafts()
  quiet.mockRestore()

  expect(positionOf(scope)).toBeUndefined()
})
