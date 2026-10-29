import { describe, expect, it } from 'vitest'
import { useAppStore } from '../store'
import type { OpenFile } from '../store/slices/editor/types/open-file'
import { discoverSessionSources } from './test-support/session-source-discovery'
import { SessionUnitProjection } from './session-unit-projection'
import { buildEditorSessionData } from './workspace-session'
import type { AppState } from '../store/types'

function file(filePath: string, worktreeId = 'repo::/a'): OpenFile {
  return {
    id: 'duplicate',
    filePath,
    relativePath: filePath,
    worktreeId,
    language: 'text',
    mode: 'edit',
    isDirty: false
  }
}
function fixture(openFiles: OpenFile[] = []): AppState {
  return {
    ...useAppStore.getState(),
    openFiles,
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    editorDrafts: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    markdownFrontmatterVisible: {}
  }
}

describe('flush-time source discovery preserves native collection semantics', () => {
  it('keeps first occurrence lookup and all-occurrence updates in callback order', () => {
    const repeated = file('first.txt')
    const before = fixture([repeated, file('second.txt'), file('third.txt', 'other::/b'), repeated])
    expect(before.openFiles.find((row) => row.id === 'duplicate')).toBe(repeated)
    const projection = new SessionUnitProjection(before)
    const calls: string[] = []
    Object.freeze(repeated)
    Object.freeze(before.openFiles)
    const after = {
      ...before,
      openFiles: before.openFiles.map((row) => {
        calls.push(row.filePath)
        return row.id === 'duplicate' ? { ...row, isDirty: true } : row
      }),
      editorDrafts: { duplicate: 'draft' }
    }
    const discovery = discoverSessionSources(before, after)
    expect(calls).toEqual(['first.txt', 'second.txt', 'third.txt', 'first.txt'])
    expect([...(discovery.changes.get('openFiles') ?? [])]).toEqual(['repo::/a', 'other::/b'])
    const update = projection.update(after, discovery)
    expect(update.patch.openFilesByWorktree).toEqual(
      buildEditorSessionData(after.openFiles, after.editorDrafts, {}, {}, {}).openFilesByWorktree
    )
    expect(before.openFiles.every((row) => !row.isDirty)).toBe(true)
  })

  it('discovers occurrence reorder, repeated references, moves and the last removal', () => {
    const a = file('a'),
      b = file('b')
    const before = fixture([a, b, a])
    const reordered = { ...before, openFiles: [a, a, b] }
    expect([...(discoverSessionSources(before, reordered).changes.get('openFiles') ?? [])]).toEqual(
      ['repo::/a']
    )
    const moved = { ...before, openFiles: [a, { ...b, worktreeId: 'other::/b' }, a] }
    expect([...(discoverSessionSources(before, moved).changes.get('openFiles') ?? [])]).toEqual([
      'repo::/a',
      'other::/b'
    ])
    expect([
      ...(discoverSessionSources(before, { ...before, openFiles: [] }).changes.get('openFiles') ??
        [])
    ]).toEqual(['repo::/a'])
  })

  it('selects every owner of a shared draft without collapsing duplicate rows', () => {
    const before = fixture([file('a'), file('b'), file('c', 'other::/b')])
    const projection = new SessionUnitProjection(before)
    const dirty = {
      ...before,
      openFiles: before.openFiles.map((row) => ({ ...row, isDirty: true }))
    }
    projection.update(dirty, discoverSessionSources(before, dirty))
    const after = { ...dirty, editorDrafts: { duplicate: 'latest' } }
    const update = projection.update(after, discoverSessionSources(dirty, after))
    expect(Object.keys(update.patch.openFilesByWorktree ?? {})).toEqual(['repo::/a', 'other::/b'])
    expect(update.patch.openFilesByWorktree?.['repo::/a']).toHaveLength(2)
    expect(update.patch.openFilesByWorktree?.['other::/b'][0].dirtyDraftContent).toBe('latest')
  })

  it('distinguishes own-property presence, deletion and reinsert order', () => {
    const before = fixture()
    const initial = { ...before, activeFileIdByWorktree: { a: null, b: null } }
    const removed = { ...initial, activeFileIdByWorktree: { b: null } }
    expect([
      ...(discoverSessionSources(initial, removed).changes.get('activeFileIdByWorktree') ?? [])
    ]).toEqual(['a'])
    const reordered = { ...initial, activeFileIdByWorktree: { b: null, a: null } }
    expect(discoverSessionSources(initial, reordered).full).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: own undefined is intentional malformed fixture input for the presence oracle.
    const ownUndefined = Object.fromEntries([
      ['a', undefined]
    ]) as unknown as AppState['lastVisitedAtByWorktreeId']
    const present = { ...before, lastVisitedAtByWorktreeId: ownUndefined }
    expect([
      ...(discoverSessionSources(before, present).changes.get('lastVisitedAtByWorktreeId') ?? [])
    ]).toEqual(['a'])
    expect(discoverSessionSources(removed, reordered).full).toBe(false)
  })

  it('compares actual Map entries and skips every unchanged field', () => {
    const before = fixture()
    const after = { ...before, sshConnectionStates: new Map(before.sshConnectionStates) }
    expect(discoverSessionSources(before, after).changes.get('sshConnectionStates')?.size).toBe(0)
    Object.defineProperty(before.tabsByWorktree, 'unrelated', {
      enumerable: true,
      get() {
        throw new Error('unchanged field inspected')
      }
    })
    expect(discoverSessionSources(before, before).changes.size).toBe(0)
  })
})

it('removes file-keyed dependents when the last occurrence closes', () => {
  const row = file('draft.md')
  const before = { ...fixture([row]), markdownFrontmatterVisible: { duplicate: false } }
  const projection = new SessionUnitProjection(before)
  const after = { ...before, openFiles: [] }
  const update = projection.update(after, discoverSessionSources(before, after))
  expect(update.keys.get('markdownFrontmatterVisible')).toEqual(new Set(['duplicate']))
  expect(update.patch.markdownFrontmatterVisible).toEqual({})
  expect(update.keys.get('openFilesByWorktree')).toEqual(new Set(['repo::/a']))
})

it('compares Record membership and string order against native patch application', () => {
  const shapes: Record<string, number>[] = [
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { b: 2, c: 3 },
    { c: 3, b: 2 },
    { '2': 2, a: 1 },
    { '1': 1, '2': 2, a: 1 },
    { '4294967294': 2, '01': 1, a: 1 },
    { a: 1, '01': 1, '4294967295': 2 },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this malformed own-undefined entry is part of the independent presence matrix.
    Object.fromEntries([['a', undefined]]) as unknown as AppState['lastVisitedAtByWorktreeId'],
    {}
  ]
  for (const old of shapes) {
    for (const next of shapes) {
      const initial = { ...fixture(), lastVisitedAtByWorktreeId: Object.freeze(old) }
      const after = { ...initial, lastVisitedAtByWorktreeId: Object.freeze(next) }
      const discovery = discoverSessionSources(initial, after, ['lastVisitedAtByWorktreeId'])
      const candidate = { ...old },
        keys = new Set<string>()
      for (const key of Object.keys(old)) {
        if (!Object.hasOwn(next, key)) {
          delete candidate[key]
          keys.add(key)
        }
      }
      for (const key of Object.keys(next)) {
        if (!Object.hasOwn(old, key) || old[key] !== next[key]) {
          candidate[key] = next[key]
          keys.add(key)
        }
      }
      expect(new Set(discovery.changes.get('lastVisitedAtByWorktreeId'))).toEqual(keys)
      expect(discovery.full).toBe(
        JSON.stringify(Object.keys(candidate)) !== JSON.stringify(Object.keys(next))
      )
    }
  }
})
