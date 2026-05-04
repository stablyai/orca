import { describe, expect, it } from 'vitest'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  isPathMode,
  parentPath,
  parsePathInput,
  resolveSegmentStep,
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
    const filtered = filterEntries(entries, 'e')
    expect(decideEnterAction(filtered)).toEqual({ type: 'navigate', name: 'node_modules' })
  })

  it('is a no-op when multiple folders match', () => {
    const filtered = filterEntries(entries, 's')
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

describe('parentPath', () => {
  it('strips last segment', () => {
    expect(parentPath('/home/neil/docs')).toBe('/home/neil')
  })
  it('stays at root', () => {
    expect(parentPath('/')).toBe('/')
  })
  it('returns root for single-segment absolute', () => {
    expect(parentPath('/home')).toBe('/')
  })
})

describe('isPathMode', () => {
  it('treats plain names as filter mode', () => {
    expect(isPathMode('docs')).toBe(false)
    expect(isPathMode('README.md')).toBe(false)
    expect(isPathMode('')).toBe(false)
  })

  it('treats any `/` as path mode', () => {
    expect(isPathMode('a/b')).toBe(true)
    expect(isPathMode('/')).toBe(true)
    expect(isPathMode('foo/')).toBe(true)
  })

  it('treats bare base markers as path mode', () => {
    expect(isPathMode('~')).toBe(true)
    expect(isPathMode('.')).toBe(true)
    expect(isPathMode('..')).toBe(true)
  })
})

describe('parsePathInput', () => {
  it('no slash stays in filter mode', () => {
    expect(parsePathInput('docs')).toEqual({ mode: 'filter', filter: 'docs' })
  })

  it('`..` enters path mode and resolves to parent', () => {
    expect(parsePathInput('..')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['..'],
      trailingFilter: ''
    })
  })

  it('`../sibling` commits `..` and filters by `sibling`', () => {
    expect(parsePathInput('../sibling')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['..'],
      trailingFilter: 'sibling'
    })
  })

  it('`Documents/orca` commits `Documents` and filters by `orca`', () => {
    expect(parsePathInput('Documents/orca')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['Documents'],
      trailingFilter: 'orca'
    })
  })

  it('`Documents/` commits `Documents` with empty filter', () => {
    expect(parsePathInput('Documents/')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['Documents'],
      trailingFilter: ''
    })
  })

  it('`/var/log` resolves from root', () => {
    expect(parsePathInput('/var/log')).toEqual({
      mode: 'path',
      base: 'root',
      committedSegments: ['var'],
      trailingFilter: 'log'
    })
  })

  it('`~/Documents` resolves from home', () => {
    expect(parsePathInput('~/Documents')).toEqual({
      mode: 'path',
      base: 'home',
      committedSegments: [],
      trailingFilter: 'Documents'
    })
  })

  it('`~` resolves to home with no committed segments', () => {
    expect(parsePathInput('~')).toEqual({
      mode: 'path',
      base: 'home',
      committedSegments: [],
      trailingFilter: ''
    })
  })

  it('`./child` resolves from cwd', () => {
    expect(parsePathInput('./child')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['.'],
      trailingFilter: 'child'
    })
  })

  it('reports repeated separators as invalid', () => {
    const parsed = parsePathInput('foo//bar')
    expect(parsed.mode).toBe('path')
    if (parsed.mode === 'path') {
      expect(parsed.invalid).toMatch(/repeated separators/)
    }
  })

  it('preserves spaces inside segments', () => {
    expect(parsePathInput('My Folder/sub dir')).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: ['My Folder'],
      trailingFilter: 'sub dir'
    })
  })

  it('preserves leading/trailing spaces in the full input', () => {
    // Leading space keeps it in filter mode unless a `/` or base marker
    // appears; once path mode is triggered, spaces must not be trimmed.
    const parsed = parsePathInput(' foo /bar ')
    expect(parsed).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: [' foo '],
      trailingFilter: 'bar '
    })
  })
})

describe('resolveSegmentStep', () => {
  const listing: DirEntry[] = [
    { name: 'Documents', isDirectory: true },
    { name: 'Downloads', isDirectory: true },
    { name: 'orca-internal', isDirectory: true },
    { name: 'notes.txt', isDirectory: false }
  ]

  it('exact directory match descends', () => {
    expect(resolveSegmentStep('Documents', '/home/neil', listing)).toEqual({
      type: 'descend',
      name: 'Documents'
    })
  })

  it('unique prefix descends', () => {
    expect(resolveSegmentStep('orca', '/home/neil', listing)).toEqual({
      type: 'descend',
      name: 'orca-internal'
    })
  })

  it('ambiguous prefix errors', () => {
    const r = resolveSegmentStep('Do', '/home/neil', listing)
    expect(r.type).toBe('error')
    if (r.type === 'error') {
      expect(r.message).toMatch(/multiple directories/)
    }
  })

  it('missing segment errors', () => {
    const r = resolveSegmentStep('zzz', '/home/neil', listing)
    expect(r.type).toBe('error')
  })

  it('exact file match reports not-a-directory instead of prefix-descending', () => {
    // `notes.txt` matches exactly as a file; must not fall through to a
    // prefix-match heuristic that picks the first folder starting with "n".
    const r = resolveSegmentStep('notes.txt', '/home/neil', listing)
    expect(r.type).toBe('error')
    if (r.type === 'error') {
      expect(r.message).toMatch(/isn't a directory/)
    }
  })

  it('`.` stays', () => {
    expect(resolveSegmentStep('.', '/home/neil', listing).type).toBe('stay')
  })

  it('`..` stays (parent nav handled by caller)', () => {
    expect(resolveSegmentStep('..', '/home/neil', listing).type).toBe('stay')
  })

  it('case-insensitive exact match descends when no case-sensitive match exists', () => {
    expect(resolveSegmentStep('documents', '/home/neil', listing)).toEqual({
      type: 'descend',
      name: 'Documents'
    })
  })

  it('case-insensitive unique prefix descends', () => {
    expect(resolveSegmentStep('down', '/home/neil', listing)).toEqual({
      type: 'descend',
      name: 'Downloads'
    })
  })

  it('case-sensitive exact match wins over a case-insensitive peer', () => {
    const mixed: DirEntry[] = [
      { name: 'Documents', isDirectory: true },
      { name: 'documents', isDirectory: true }
    ]
    expect(resolveSegmentStep('documents', '/home/neil', mixed)).toEqual({
      type: 'descend',
      name: 'documents'
    })
    expect(resolveSegmentStep('Documents', '/home/neil', mixed)).toEqual({
      type: 'descend',
      name: 'Documents'
    })
  })

  it('case-insensitive ambiguous prefix errors', () => {
    const r = resolveSegmentStep('do', '/home/neil', listing)
    expect(r.type).toBe('error')
    if (r.type === 'error') {
      expect(r.message).toMatch(/multiple directories/)
    }
  })
})
