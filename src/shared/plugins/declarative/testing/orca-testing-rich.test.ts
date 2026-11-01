import { afterEach, describe, expect, it } from 'vitest'
import { atom, read, set } from '../runtime/declarative-atoms'
import { h } from '../runtime/declarative-elements'
import { mockHost, mount, type TestPanel } from './orca-testing'

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
})

type Row = { key: string; name: string; size: number }
const FILES: Row[] = Array.from({ length: 25 }, (_, index) => ({
  key: `f${index}`,
  name: `file-${String(index).padStart(2, '0')}.ts`,
  size: (index * 37) % 100
}))
const sort = atom<{ column: string; direction: 'asc' | 'desc' }>({
  column: 'name',
  direction: 'asc'
})
const loaded = atom(10)
const selected = atom<string[]>([])
const opened = atom<string[]>([])
const lazy = atom<{ key: string; label: string }[] | null>(null)
const notes = atom('')
const volume = atom(3)

function Files() {
  const { column, direction } = read(sort)
  const rows = [...FILES]
    .sort((a, b) => {
      const order = column === 'size' ? a.size - b.size : a.name.localeCompare(b.name)
      return direction === 'asc' ? order : -order
    })
    .slice(0, read(loaded))
    .map((row) => ({ key: row.key, cells: { name: row.name, size: row.size } }))
  return h(
    'Stack',
    null,
    h(
      'Tabs',
      { label: 'Views', defaultValue: 'files' },
      h(
        'Tab',
        { value: 'files', label: 'Files' },
        h('Table', {
          label: 'Files',
          columns: [
            { key: 'name', label: 'Name', sortable: true },
            { key: 'size', label: 'Size', align: 'end', sortable: true }
          ],
          rows,
          sort: read(sort),
          selectionMode: 'multiple',
          selected: read(selected),
          hasMore: read(loaded) < FILES.length,
          onSortChange: (next: { column: string; direction: 'asc' | 'desc' }) => set(sort, next),
          onSelectionChange: ({ keys }: { keys: string[] }) => set(selected, keys),
          onRowAction: ({ key }: { key: string }) => set(opened, [...read(opened), key]),
          onLoadMore: () => set(loaded, read(loaded) + 10)
        })
      ),
      h(
        'Tab',
        { value: 'settings', label: 'Settings' },
        h('Textarea', {
          label: 'Notes',
          value: read(notes),
          onChange: (v: string) => set(notes, v)
        }),
        h('Slider', {
          label: 'Volume',
          min: 0,
          max: 10,
          value: read(volume),
          onChange: (v: number) => set(volume, v)
        }),
        h('Checkbox', { label: 'Verbose', defaultChecked: false }),
        h('RadioGroup', {
          label: 'Mode',
          defaultValue: 'fast',
          options: [
            { value: 'fast', label: 'Fast' },
            { value: 'safe', label: 'Safe', disabled: true }
          ]
        })
      )
    ),
    h('Collapsible', { title: 'Folders' }, h('Text', null, 'Tree below')),
    h('Tree', {
      label: 'Folders',
      items: [{ key: 'src', label: 'src', hasChildren: true, children: read(lazy) ?? undefined }],
      onToggle: ({ key, expanded }: { key: string; expanded: boolean }) => {
        if (key === 'src' && expanded) {
          set(lazy, [{ key: 'src/main.ts', label: 'main.ts' }])
        }
      },
      onSelect: () => undefined
    })
  )
}

describe('orca/testing with catalog 2', () => {
  it('sorts, selects, activates and pages a Table', async () => {
    panel = await mount(Files, { host: mockHost() })
    const table = { type: 'Table' }
    expect(panel.rowsOf(table)).toHaveLength(10)
    expect(panel.rowsOf(table)[0]).toBe('f0')
    await panel.sort(table, 'name')
    expect(panel.rowsOf(table)[0]).toBe('f24')
    await panel.sort(table, 'name')
    expect(panel.rowsOf(table)[0]).toBe('f0')
    await panel.selectRows(table, ['f1', 'f2'])
    expect(panel.valueOf(table)).toEqual(['f1', 'f2'])
    await panel.activateRow(table, 'f2')
    expect(read(opened)).toEqual(['f2'])
    await panel.loadMore(table)
    await panel.loadMore(table)
    expect(panel.rowsOf(table)).toHaveLength(25)
    await expect(panel.loadMore(table)).rejects.toThrow(/no more rows/)
    await expect(panel.selectRows(table, ['nope'])).rejects.toThrow(/no enabled row "nope"/)
    expect(panel.find({ text: /file-03\.ts/ })?.type).toBe('Table')
  })

  it('shows only the selected tab and an open Collapsible, like Orca draws them', async () => {
    panel = await mount(Files)
    expect(panel.find({ label: 'Notes' })).toBeNull()
    expect(panel.find({ text: 'Tree below' })).toBeNull()
    await panel.select({ type: 'Tabs' }, 'settings')
    expect(panel.find({ type: 'Table' })).toBeNull()
    await panel.type({ label: 'Notes' }, 'hi')
    expect(read(notes)).toBe('hi')
    await panel.slide({ label: 'Volume' }, 7)
    expect(read(volume)).toBe(7)
    await expect(panel.slide({ label: 'Volume' }, 11)).rejects.toThrow(/outside/)
    await panel.toggle({ label: 'Verbose' })
    expect(panel.valueOf({ label: 'Verbose' })).toBe(true)
    await expect(panel.select({ label: 'Mode' }, 'safe')).rejects.toThrow(/no enabled option/)
    await panel.toggle({ type: 'Collapsible' })
    expect(panel.find({ text: 'Tree below' })?.type).toBe('Text')
    await expect(panel.select({ type: 'Tabs' }, 'missing')).rejects.toThrow(/no enabled option/)
  })

  it('expands a lazy Tree item and selects what it loaded', async () => {
    panel = await mount(Files)
    const tree = { role: 'tree' }
    // An absent field (`children: undefined`) never reaches Orca.
    expect(panel.find(tree)?.props.items).toEqual([{ key: 'src', label: 'src', hasChildren: true }])
    await panel.expand(tree, 'src')
    expect(panel.expandedOf(tree)).toEqual(['src'])
    expect(panel.find({ text: /main\.ts/ })?.type).toBe('Tree')
    await panel.selectItem(tree, 'src/main.ts')
    expect(panel.valueOf(tree)).toBe('src/main.ts')
    await panel.collapse(tree, 'src')
    expect(panel.expandedOf(tree)).toEqual([])
    await expect(panel.expand(tree, 'src/main.ts')).rejects.toThrow(/has no children/)
    expect(panel.errors).toEqual([])
  })
})

describe('summary and responsive columns', () => {
  it('summarizes what a person notices first, and which columns fit a width', async () => {
    panel = await mount(() =>
      h(
        'Stack',
        null,
        h('Heading', null, 'Review queue'),
        h('Callout', { tone: 'danger', title: 'Could not load the queue' }, 'offline'),
        h('Table', {
          label: 'PRs',
          columns: [
            { key: 'title', label: 'Title', minWidth: 'sm' },
            { key: 'author', label: 'Author', hideBelow: 'sm' },
            { key: 'checks', label: 'Checks', hideBelow: 'md' }
          ],
          rows: [
            { key: 'a', cells: { title: 'One' } },
            { key: 'b', cells: { title: 'Two' } }
          ]
        }),
        h('List', { label: 'Later' }, h('ListItem', { title: 'x' })),
        h('EmptyState', { title: 'All caught up' })
      )
    )
    expect(panel.summary()).toEqual([
      'Heading "Review queue"',
      'Callout danger "Could not load the queue"',
      'Table "PRs": 2 row(s)',
      'List "Later": 1 item(s)',
      'EmptyState "All caught up"'
    ])
    const table = { type: 'Table' }
    expect(panel.columnsOf(table)).toEqual(['title', 'author', 'checks'])
    expect(panel.columnsOf(table, { width: 400 })).toEqual(['title', 'author'])
    expect(panel.columnsOf(table, { width: 300 })).toEqual(['title'])
  })
})
