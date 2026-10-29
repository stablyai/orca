import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useAppStore } from './index'
import {
  editSessionSource,
  unwrapSessionSourceWrite,
  type SessionSourceWrite
} from './session-source-edits'
import {
  replaceSessionSourceFields,
  withSessionSourceWrites
} from './session-source-write-boundary'
import {
  discoverSessionSources,
  type SessionSourceDiscovery
} from '../lib/test-support/session-source-discovery'
import type { AppState } from './types'
import { withEditorBufferRecords } from './editor-buffer-record-lifecycle'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { TEST_REPO } from './slices/worktrees-slice-test-fixtures'
import { SessionSourceReceipts } from '../lib/session-source-receipts'

function fixture(): AppState {
  return {
    ...useAppStore.getState(),
    activeTabId: null,
    editorDrafts: { a: 'before', b: 'untouched' },
    openFiles: [],
    tabsByWorktree: {},
    sshConnectionStates: new Map()
  }
}

function verify(before: AppState, write: SessionSourceWrite<AppState>): AppState {
  const next = { ...before, ...unwrapSessionSourceWrite(write).partial }
  expect(unwrapSessionSourceWrite(write).receipt!.changes).toEqual(
    discoverSessionSources(before, next).changes
  )
  expect(unwrapSessionSourceWrite(write).receipt!.full).toBe(
    discoverSessionSources(before, next).full
  )
  return next
}

describe('atomic named source edits', () => {
  it('matches the independent native diff for presence and restored edits with frozen roots', () => {
    const before = fixture()
    Object.freeze(before.editorDrafts)
    Object.freeze(before)
    const edit = editSessionSource(before)
    edit.set('editorDrafts', 'a', 'changed')
    edit.remove('editorDrafts', 'b')
    edit.set('editorDrafts', 'a', 'before')
    edit.set('editorDrafts', 'c', 'new')
    const write = edit.finish()
    const next = verify(before, write)
    expect(next.editorDrafts).toEqual({ a: 'before', c: 'new' })
    expect(before.editorDrafts).toEqual({ a: 'before', b: 'untouched' })
    Object.freeze(next.editorDrafts)
    edit.set('editorDrafts', 'c', 'later')
    expect(next.editorDrafts.c).toBe('new')
    verify(before, edit.finish())
  })

  it('uses full replacement for order changes and preserves integer property order', () => {
    const before = fixture()
    verify(
      before,
      editSessionSource(before)
        .set('editorDrafts', '2', 'two')
        .set('editorDrafts', '1', 'one')
        .finish()
    )
    const reordered = editSessionSource(before)
      .remove('editorDrafts', 'a')
      .set('editorDrafts', 'a', 'before')
      .finish()
    expect(unwrapSessionSourceWrite(reordered).receipt!.full).toBe(true)
    expect(Object.keys(unwrapSessionSourceWrite(reordered).partial.editorDrafts!)).toEqual([
      'b',
      'a'
    ])
    const empty = editSessionSource(before)
      .replace('editorDrafts', {}, 'hydration')
      .set('editorDrafts', 'c', 'new')
      .finish()
    expect(unwrapSessionSourceWrite(empty).partial.editorDrafts).toEqual({ c: 'new' })
    expect(before.editorDrafts).toEqual({ a: 'before', b: 'untouched' })
  })

  it('derives field-level receipts from the final accepted write', () => {
    const store = createStore<AppState>()(withSessionSourceWrites(fixture, true))
    const before = store.getState()
    store.subscribe((after) => {
      expect(store.getSessionSourceReceipt()?.changes).toEqual(
        discoverSessionSources(before, after).changes
      )
    })
    store.setState(
      editSessionSource(before).set('editorDrafts', 'a', 'next').finish({ activeTabId: 'tab' })
    )
  })

  it('carries duplicate catalog occurrences from native traversal', () => {
    const row = { ...TEST_REPO, id: 'same' }
    const before = { ...fixture(), repos: [row, row] }
    const edit = editSessionSource(before)
    edit.sequence('repos').map((repo, index) => (index === 0 ? { ...repo, name: 'renamed' } : repo))
    const write = edit.finish()
    const repos = unwrapSessionSourceWrite(write).partial.repos
    verify(before, write)
    expect(unwrapSessionSourceWrite(write).receipt!.sequences?.repos?.get('same')).toEqual(repos)
    expect(before.repos).toEqual([row, row])
  })

  it('retains delete/reinsert order across accepted writes before a flush', () => {
    const before = { ...fixture(), editorDrafts: { a: 'A', b: 'B' } }
    Object.freeze(before.editorDrafts)
    Object.freeze(before)
    const first = editSessionSource(before).remove('editorDrafts', 'a').finish()
    const middle = { ...before, ...unwrapSessionSourceWrite(first).partial }
    Object.freeze(middle.editorDrafts)
    const second = editSessionSource(middle).set('editorDrafts', 'a', 'A').finish()
    const after = { ...middle, ...unwrapSessionSourceWrite(second).partial }
    const pending = new SessionSourceReceipts()
    pending.add(unwrapSessionSourceWrite(first).receipt!)
    pending.add(unwrapSessionSourceWrite(second).receipt!)
    const receipt = pending.take(before, after)
    const native = discoverSessionSources(before, after)
    expect(Object.keys(after.editorDrafts)).toEqual(['b', 'a'])
    expect(receipt.full).toBe(native.full)
    expect(receipt.full).toBe(true)
    expect(receipt.changes).toEqual(native.changes)
    expect(before.editorDrafts).toEqual({ a: 'A', b: 'B' })
  })

  it('coalesces pending keyed receipts against the captured source without enumerating Records', () => {
    const before = fixture()
    const first = editSessionSource(before).set('editorDrafts', 'a', 'temporary').finish()
    const middle = { ...before, ...unwrapSessionSourceWrite(first).partial }
    const second = editSessionSource(middle)
      .set('editorDrafts', 'a', before.editorDrafts.a)
      .remove('editorDrafts', 'b')
      .finish()
    const after = { ...middle, ...unwrapSessionSourceWrite(second).partial }
    const pending = new SessionSourceReceipts()
    pending.add(unwrapSessionSourceWrite(first).receipt!)
    pending.add(unwrapSessionSourceWrite(second).receipt!)
    const native = discoverSessionSources(before, after)
    const trap = <T extends object>(record: T): T =>
      new Proxy(record, {
        ownKeys: () => {
          throw new Error('unrelated enumeration')
        }
      })
    const receipt = pending.take(
      { ...before, editorDrafts: trap(before.editorDrafts) },
      { ...after, editorDrafts: trap(after.editorDrafts) }
    )
    expect(receipt.changes).toEqual(native.changes)
  })
})

describe('source write identity gate', () => {
  it('composes reconciled file mirrors and shared drafts before notifying subscribers', () => {
    const store = createStore<AppState>()(withEditorBufferRecords(fixture, false))
    const file = {
      id: 'a',
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      mode: 'edit' as const,
      isDirty: false
    }
    store.setState(
      replaceSessionSourceFields(
        {
          ...fixture(),
          openFiles: [{ ...file, isDirty: true }],
          editorDrafts: { a: 'shared' }
        },
        'hydration'
      ),
      true
    )
    const before = store.getState()
    let receipt: SessionSourceDiscovery | undefined
    store.subscribe(() => {
      receipt = store.getSessionSourceReceipt()
    })
    const edit = editSessionSource(before)
    const added = { ...file, id: 'b' }
    store.setState(edit.sequence('openFiles').append(added).finish())
    const after = store.getState()
    expect(after.openFiles.every((row) => row.isDirty)).toBe(true)
    expect(receipt?.changes).toEqual(discoverSessionSources(before, after).changes)
    expect(receipt?.full).toBe(false)
  })
  it('preserves identity for an explicit no-op and keeps accepted payloads opaque', () => {
    const store = createStore<AppState>()(withSessionSourceWrites(fixture, true))
    const before = store.getState()
    let notifications = 0
    store.subscribe(() => {
      notifications++
    })
    store.setState(() => undefined)
    expect(store.getState()).toBe(before)
    expect(notifications).toBe(0)
    store.setState(editSessionSource(before).finish())
    expect(store.getState()).toBe(before)
    expect(notifications).toBe(0)
    store.setState({})
    expect(store.getState()).not.toBe(before)
    expect(notifications).toBe(1)
    const write = editSessionSource(before).set('editorDrafts', 'a', 'opaque').finish()
    expect({ ...write }).toEqual({ sourceWrite: true })
    expect(Object.isFrozen(write)).toBe(true)
    expect(Object.isFrozen(unwrapSessionSourceWrite(write).partial)).toBe(true)
    store.setState(write)
    expect(store.getState().editorDrafts.a).toBe('opaque')
  })
  it('publishes receipts before synchronous subscribers, including nested notifications', () => {
    const store = createStore<AppState>()(withSessionSourceWrites(fixture, true))
    let nested = false
    const captured: string[][] = []
    store.subscribe(() => {
      if (!nested) {
        nested = true
        store.setState({ activeTabId: 'nested' })
      }
    })
    store.subscribe(() => captured.push([...store.getSessionSourceReceipt()!.changes.keys()]))
    store.setState(editSessionSource(store.getState()).set('editorDrafts', 'a', 'outer').finish())
    expect(captured).toEqual([['activeTabId'], ['editorDrafts']])
    expect(store.getSessionSourceReceipt()).toBeUndefined()
  })

  it('rejects unreported writes in development and declares one full boundary in production', () => {
    for (const development of [true, false]) {
      const store = createStore<AppState>()(withSessionSourceWrites(fixture, development))
      let full = false
      store.subscribe(() => {
        full = Boolean(store.getSessionSourceReceipt()?.full)
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this deliberately bypasses the source setter type to exercise its one runtime gate.
      const unsupported = { editorDrafts: {} } as unknown as SessionSourceWrite<AppState>
      if (development) {
        expect(() => store.setState(unsupported)).toThrow(
          'Unreported session source write: editorDrafts'
        )
      } else {
        store.setState(unsupported)
        expect(full).toBe(true)
      }
      store.setState(replaceSessionSourceFields(fixture(), 'hydration'), true)
      expect(full).toBe(true)
    }
  })
})
