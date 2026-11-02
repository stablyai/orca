// @vitest-environment happy-dom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cb, mountActGuest, node } from './plugin-view-act-test-harness'

afterEach(cleanup)

const FILES = ['b.ts', 'a.ts', 'c.ts']

/** A file browser guest: a sortable, selectable, paged Table, a lazy Tree and a Slider. */
type FilesState = {
  sort: { column: string; direction: string }
  selected: readonly string[]
  opened: string[]
  pages: number
  lazy: boolean
  treeSelected: string
  volume: number
}

function mountFilesGuest() {
  const state: FilesState = {
    sort: { column: 'name', direction: 'asc' },
    selected: [],
    opened: [],
    pages: 1,
    lazy: false,
    treeSelected: '',
    volume: 3
  }
  const guest = mountActGuest(
    () =>
      node('Stack', {}, [
        node('Table', {
          label: 'Files',
          columns: [
            { key: 'name', label: 'Name', sortable: true },
            { key: 'size', label: 'Size' }
          ],
          rows: FILES.map((name) => ({ key: name, cells: { name, size: 1 } })),
          sort: state.sort,
          selectionMode: 'multiple',
          selected: [...state.selected],
          hasMore: state.pages < 5,
          onSortChange: cb('sort'),
          onSelectionChange: cb('select'),
          onRowAction: cb('open'),
          onLoadMore: cb('more')
        }),
        node('Tree', {
          label: 'Folders',
          items: [
            {
              key: 'src',
              label: 'src',
              hasChildren: true,
              ...(state.lazy ? { children: [{ key: 'src/main.ts', label: 'main.ts' }] } : {})
            },
            { key: 'README.md', label: 'README.md' }
          ],
          selected: state.treeSelected,
          onToggle: cb('toggle'),
          onSelect: cb('pick'),
          onAction: cb('run')
        }),
        node('Slider', {
          label: 'Volume',
          min: 0,
          max: 10,
          value: state.volume,
          onChange: cb('vol')
        })
      ]),
    ({ callback, args }) => {
      const arg = args[0]
      const field = (name: string): unknown =>
        typeof arg === 'object' && arg !== null && name in arg
          ? Object.entries(arg).find(([key]) => key === name)?.[1]
          : undefined
      if (callback === 'sort') {
        state.sort = { column: String(field('column')), direction: String(field('direction')) }
      } else if (callback === 'select') {
        const keys = field('keys')
        state.selected = Array.isArray(keys) ? keys.map(String) : []
      } else if (callback === 'open') {
        state.opened.push(String(field('key')))
      } else if (callback === 'more') {
        state.pages += 1
      } else if (callback === 'toggle') {
        state.lazy = field('expanded') === true
      } else if (callback === 'pick') {
        state.treeSelected = String(field('key'))
      } else if (callback === 'vol' && typeof arg === 'number') {
        state.volume = arg
      }
    }
  )
  return { ...guest, state }
}

describe('shot --act Table, Tree and Slider verbs', () => {
  it('sorts, selects, activates and pages a Table as its header, rows and scroll would', async () => {
    const guest = mountFilesGuest()
    const table = { type: 'Table' }
    // Orca itself asks for more once the last row shows; the act asks once more on top.
    const pagesBefore = guest.state.pages
    expect(
      await guest.run([
        { sort: table, column: 'name' },
        { selectRows: table, keys: ['a.ts', 'c.ts'] },
        { activateRow: table, key: 'b.ts' },
        { loadMore: table }
      ])
    ).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }])
    // Ascending was on, so the header flips it.
    expect(guest.state.sort).toEqual({ column: 'name', direction: 'desc' })
    expect(guest.state.selected).toEqual(['a.ts', 'c.ts'])
    expect(guest.state.opened).toEqual(['b.ts'])
    expect(guest.state.pages).toBeGreaterThan(pagesBefore)
    // The last page: the guest re-renders without hasMore on its next event.
    guest.state.pages = 5
    await guest.run([{ activateRow: table, key: 'a.ts' }])
    expect(await guest.run([{ loadMore: table }])).toEqual([
      { ok: false, error: 'loadMore: the Table has no more rows (hasMore and onLoadMore)' }
    ])
    expect(await guest.run([{ sort: table, column: 'size' }])).toEqual([
      { ok: false, error: 'sort: the Table has no sortable column "size"' }
    ])
    expect(await guest.run([{ activateRow: table, key: 'z.ts' }])).toEqual([
      { ok: false, error: 'activateRow: the Table has no enabled row "z.ts"' }
    ])
  })

  it('expands a lazy Tree item, selects and activates what it loaded, then collapses it', async () => {
    const guest = mountFilesGuest()
    const tree = { label: 'Folders' }
    expect(
      await guest.run([
        { expand: tree, key: 'src' },
        { selectItem: tree, key: 'src/main.ts' },
        { activateItem: tree, key: 'src/main.ts' }
      ])
    ).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    expect(screen.getByRole('treeitem', { name: /main\.ts/ })).toBeTruthy()
    expect(guest.state.treeSelected).toBe('src/main.ts')
    // Already open: nothing more is sent, as the kit does.
    await guest.run([{ expand: tree, key: 'src' }])
    expect(guest.sent.filter((event) => event.callback === 'toggle')).toHaveLength(1)
    await guest.run([{ collapse: tree, key: 'src' }])
    expect(guest.state.lazy).toBe(false)
    expect(await guest.run([{ expand: tree, key: 'README.md' }])).toEqual([
      { ok: false, error: 'expand: the Tree item "README.md" has no children' }
    ])
  })

  it('slides within the bounds only', async () => {
    const guest = mountFilesGuest()
    expect(await guest.run([{ slide: { label: 'Volume' }, value: 7 }])).toEqual([{ ok: true }])
    expect(guest.state.volume).toBe(7)
    expect(await guest.run([{ slide: { label: 'Volume' }, value: 11 }])).toEqual([
      { ok: false, error: "slide: 11 is outside the Slider's 0 to 10" }
    ])
  })
})
