import { describe, expect, it } from 'vitest'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  type DirEntry
} from './remote-file-browser-helpers'

const entries: DirEntry[] = [
  { name: 'src', isDirectory: true },
  { name: 'docs', isDirectory: true },
  { name: 'README.md', isDirectory: false },
  { name: '.env', isDirectory: false },
  { name: 'node_modules', isDirectory: true }
]

describe('filterEntries', () => {
  it('substring-matches case-insensitively across files and folders', () => {
    expect(filterEntries(entries, 'RE').map((e) => e.name)).toEqual(['README.md'])
    expect(filterEntries(entries, 'o').map((e) => e.name)).toEqual(['docs', 'node_modules'])
  })

  it('returns the full list when filter is empty or whitespace', () => {
    expect(filterEntries(entries, '')).toHaveLength(entries.length)
    expect(filterEntries(entries, '   ')).toHaveLength(entries.length)
  })
})

describe('decideEnterAction', () => {
  it('navigates when filter matches exactly one folder (files alongside do not block)', () => {
    const filtered = filterEntries(entries, 'e') // README.md, .env, node_modules
    expect(decideEnterAction(filtered)).toEqual({ type: 'navigate', name: 'node_modules' })
  })

  it('is a no-op when multiple folders match', () => {
    const filtered = filterEntries(entries, 's') // src, docs (+ no files with s)
    // two folders → cannot disambiguate → noop
    expect(decideEnterAction(filtered)).toEqual({ type: 'noop' })
  })

  it('shows the file hint when only files match', () => {
    const filtered = filterEntries(entries, 'readme')
    expect(decideEnterAction(filtered)).toEqual({ type: 'fileHint' })
  })

  it('is a no-op on empty filtered list', () => {
    expect(decideEnterAction([])).toEqual({ type: 'noop' })
  })
})

describe('decideEscAction', () => {
  it('clears a non-empty filter', () => {
    expect(decideEscAction('foo')).toEqual({ type: 'clearFilter' })
  })

  it('cancels when filter is empty', () => {
    expect(decideEscAction('')).toEqual({ type: 'cancel' })
  })
})
