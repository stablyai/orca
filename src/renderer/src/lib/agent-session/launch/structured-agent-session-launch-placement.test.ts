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
