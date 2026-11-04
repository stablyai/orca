// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import { PluginDeclarativeView, type PluginDeclarativeViewProps } from './PluginDeclarativeView'
import { pluginDeclarativeGestureId } from './plugin-declarative-gesture-geometry'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const cb = (id: string) => ({ $callback: id })
const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function view(raw: unknown, extra: Partial<PluginDeclarativeViewProps> = {}) {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  expect(parsed.warnings).toEqual([])
  const onEvent = vi.fn()
  render(
    <TooltipProvider>
      <PluginDeclarativeView tree={parsed.tree} onEvent={onEvent} {...extra} />
    </TooltipProvider>
  )
  return { onEvent }
}

describe('catalog 2 in the host view', () => {
  it('draws form controls that report edits with their edit ids', () => {
    const { onEvent } = view(
      node('Stack', {}, [
        node('Field', { label: 'About', error: 'Too short' }, [
          node('Textarea', { label: 'Bio', onChange: cb('t'), onSubmit: cb('s') })
        ]),
        node('Checkbox', { label: 'Agree', description: 'Terms apply', onChange: cb('c') }),
        node('RadioGroup', {
          label: 'Size',
          options: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' }
          ],
          onChange: cb('r')
        }),
        node('Slider', { label: 'Volume', defaultValue: 5, max: 10, onChange: cb('v') })
      ])
    )
    expect(screen.getByRole('group', { name: 'About' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Too short')
    const bio = screen.getByRole('textbox', { name: 'Bio' })
    fireEvent.change(bio, { target: { value: 'hi' } })
    expect(onEvent).toHaveBeenLastCalledWith('t', ['hi'], { edit: 1 })
    fireEvent.keyDown(bio, { key: 'Enter', metaKey: true, ctrlKey: true })
    expect(onEvent).toHaveBeenLastCalledWith('s', ['hi'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agree' }))
    expect(onEvent).toHaveBeenLastCalledWith('c', [true], { edit: 1 })
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }))
    expect(onEvent).toHaveBeenLastCalledWith('r', ['l'], { edit: 1 })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Volume' }), { key: 'ArrowRight' })
    expect(onEvent).toHaveBeenLastCalledWith('v', [6], { edit: 1 })
  })

  it('draws only the selected tab and opens a Collapsible on demand', () => {
    const { onEvent } = view(
      node('Stack', {}, [
        node('Tabs', { label: 'Views', onChange: cb('tabs') }, [
          node('Tab', { value: 'a', label: 'Alpha' }, [node('Text', {}, ['alpha body'])]),
          node('Tab', { value: 'b', label: 'Beta' }, [node('Text', {}, ['beta body'])])
        ]),
        node('Collapsible', { title: 'More', onChange: cb('more') }, [node('Text', {}, ['inside'])])
      ])
    )
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeTruthy()
    expect(screen.queryByText('alpha body')).not.toBeNull()
    expect(screen.queryByText('beta body')).toBeNull()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Beta' }), { button: 0 })
    expect(onEvent).toHaveBeenLastCalledWith('tabs', ['b'], { edit: 1 })
    expect(screen.queryByText('beta body')).not.toBeNull()
    expect(screen.queryByText('inside')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onEvent).toHaveBeenLastCalledWith('more', [true], { edit: 1 })
    expect(screen.queryByText('inside')).not.toBeNull()
  })

  it('moves focus along a Toolbar with arrow keys', () => {
    view(
      node('Toolbar', { label: 'Edit' }, [
        node('Button', { onPress: cb('a') }, ['Cut']),
        node('IconButton', { icon: 'copy', label: 'Copy', tooltip: 'Copy selection' })
      ])
    )
    const cut = screen.getByRole('button', { name: 'Cut' })
    cut.focus()
    fireEvent.keyDown(cut, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(cut)
  })

  it('draws a Table that selects, sorts and asks for more rows', () => {
    // happy-dom lays nothing out; give the scroll area a height so rows come into view.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(256)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
    const rows = Array.from({ length: 3 }, (_, index) => ({
      key: `r${index}`,
      cells: { name: `row ${index}`, done: index === 0 }
    }))
    const { onEvent } = view(
      node('Table', {
        label: 'Files',
        columns: [
          { key: 'name', label: 'Name', sortable: true },
          { key: 'done', label: 'Done', width: 'xs' }
        ],
        rows,
        selectionMode: 'single',
        hasMore: true,
        onSelectionChange: cb('sel'),
        onSortChange: cb('sort'),
        onRowAction: cb('act'),
        onLoadMore: cb('more')
      })
    )
    const grid = screen.getByRole('grid', { name: 'Files' })
    expect(grid.getAttribute('aria-rowcount')).toBe('4')
    expect(onEvent).toHaveBeenCalledWith('more', [])
    expect(onEvent.mock.calls.filter(([id]) => id === 'more')).toHaveLength(1)
    fireEvent.click(screen.getByText('row 1'))
    expect(onEvent).toHaveBeenLastCalledWith('sel', [{ keys: ['r1'] }], { edit: 1 })
    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onEvent).toHaveBeenLastCalledWith('act', [{ key: 'r1' }])
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(onEvent).toHaveBeenLastCalledWith('sort', [{ column: 'name', direction: 'asc' }])
    expect(screen.getByLabelText('Yes')).toBeTruthy()
  })

  it('draws a Tree that expands lazily from the keyboard and reports actions', () => {
    const { onEvent } = view(
      node('Tree', {
        label: 'Folders',
        items: [
          { key: 'src', label: 'src', hasChildren: true },
          { key: 'docs', label: 'docs', children: [{ key: 'docs/a', label: 'a.md' }] }
        ],
        defaultExpanded: ['docs'],
        onToggle: cb('toggle'),
        onSelect: cb('select'),
        onAction: cb('action')
      })
    )
    const src = screen.getByRole('treeitem', { name: 'src' })
    expect(screen.getByRole('treeitem', { name: 'a.md' }).getAttribute('aria-level')).toBe('2')
    fireEvent.keyDown(src, { key: 'ArrowRight' })
    expect(onEvent).toHaveBeenLastCalledWith('toggle', [{ key: 'src', expanded: true }])
    expect(src.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Loading…')).toBeTruthy()
    fireEvent.keyDown(src, { key: ' ' })
    expect(onEvent).toHaveBeenLastCalledWith('select', [{ key: 'src' }], { edit: 1 })
    fireEvent.keyDown(src, { key: 'Enter' })
    expect(onEvent).toHaveBeenLastCalledWith('action', [{ key: 'src' }])
    fireEvent.keyDown(src, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('docs')
  })

  it("keeps a Tree's open items when the plugin holds them in `expanded`", () => {
    const tree = (expanded: string[]) =>
      node('Tree', {
        label: 'Folders',
        items: [{ key: 'src', label: 'src', children: [{ key: 'src/a', label: 'a.ts' }] }],
        expanded,
        onToggle: cb('toggle')
      })
    const first = view(tree(['src']))
    expect(screen.getByRole('treeitem', { name: 'a.ts' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'src' }), { key: 'ArrowLeft' })
    expect(first.onEvent).toHaveBeenLastCalledWith('toggle', [{ key: 'src', expanded: false }])
    // Shown at once, before the plugin's next render.
    expect(screen.queryByRole('treeitem', { name: 'a.ts' })).toBeNull()
    cleanup()
    // A remount (a tab switch) starts from the plugin's list again.
    view(tree(['src']))
    expect(screen.getByRole('treeitem', { name: 'a.ts' })).toBeTruthy()
  })

  it('opens Markdown links through the checked path and never loads a remote image', () => {
    const content =
      '[docs](https://example.com/docs) [bad](javascript:alert(1))\n\n![x](https://example.com/x.png)'
    const onOpenLink = vi.fn()
    view(node('Markdown', { content }), { onOpenLink })
    fireEvent.click(screen.getByRole('link', { name: 'docs' }))
    expect(onOpenLink).toHaveBeenCalledWith(
      'https://example.com/docs',
      pluginDeclarativeGestureId.markdown(content)
    )
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('loads plugin images through the host and draws data components', async () => {
    const onLoadImage = vi.fn(async () => 'blob:orca/logo')
    view(
      node('Stack', {}, [
        node('Image', { src: 'assets/logo.png', alt: 'Logo' }),
        node('KeyValue', { items: [{ label: 'Branch', value: 'main', code: true }] }),
        node('Callout', { tone: 'danger', title: 'Broken' }, ['Fix it']),
        node('Skeleton', { lines: 2, label: 'Loading files' }),
        node('CodeView', { code: 'a\nb', lineNumbers: true, label: 'notes.txt' })
      ]),
      { onLoadImage }
    )
    await act(async () => undefined)
    expect(onLoadImage).toHaveBeenCalledWith('assets/logo.png')
    expect(screen.getByRole('img', { name: 'Logo' }).getAttribute('src')).toBe('blob:orca/logo')
    expect(screen.getByText('main').tagName).toBe('DD')
    expect(screen.getByRole('note').textContent).toContain('Broken')
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('keeps a RelativeTime current without the plugin polling', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1, 12) })
    try {
      const at = Date.now() - 58_000
      view(node('Text', {}, ['Started ', node('RelativeTime', { at, format: 'long' })]))
      expect(screen.getByText('58 seconds ago').tagName).toBe('TIME')
      // Each tick schedules the next after React commits, so step one second at a time.
      for (let second = 0; second < 3; second++) {
        act(() => {
          vi.advanceTimersByTime(1000)
        })
      }
      expect(screen.getByText('1 minute ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops hideBelow columns in a narrow table and rings the active row only with focus', () => {
    // happy-dom lays nothing out; give the scroll area a height so rows come into view.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(256)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
    const reports: ((entries: { contentRect: { width: number } }[]) => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
          reports.push(callback)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    view(
      node('Table', {
        label: 'PRs',
        columns: [
          { key: 'title', label: 'Title', minWidth: 'sm' },
          { key: 'author', label: 'Author', hideBelow: 'sm' }
        ],
        rows: [{ key: 'a', cells: { title: 'A very long pull request title', author: 'ana' } }]
      })
    )
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Title',
      'Author'
    ])
    expect(screen.getAllByRole('row')[1]?.className).toContain(
      'group-focus-visible/grid:data-[active=true]:ring-1'
    )
    act(() => reports.forEach((report) => report([{ contentRect: { width: 300 } }])))
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Title'
    ])
    expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('1')
    vi.unstubAllGlobals()
  })

  it('keeps a button at its own width in a default Stack, and stretches it on request', () => {
    view(
      node('Stack', {}, [
        node('Button', {}, ['Natural']),
        node('Stack', { align: 'stretch' }, [node('Button', {}, ['Wide'])])
      ])
    )
    const natural = screen.getByRole('button', { name: 'Natural' }).parentElement
    const stretched = screen.getByRole('button', { name: 'Wide' }).parentElement
    expect(natural?.getAttribute('data-align')).toBe('default')
    expect(stretched?.getAttribute('data-align')).toBe('stretch')
  })
})
