// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import type { PluginDeclarativeNode } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeView } from './PluginDeclarativeView'

afterEach(cleanup)

const cb = (id: string) => ({ $callback: id })
const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function tree(raw: unknown): PluginDeclarativeNode {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  return parsed.tree
}

function view(raw: unknown, onEvent = vi.fn(), onOpenLink = vi.fn()) {
  const result = render(
    <TooltipProvider>
      <PluginDeclarativeView tree={tree(raw)} onEvent={onEvent} onOpenLink={onOpenLink} />
    </TooltipProvider>
  )
  const rerender = (next: unknown) =>
    result.rerender(
      <TooltipProvider>
        <PluginDeclarativeView tree={tree(next)} onEvent={onEvent} onOpenLink={onOpenLink} />
      </TooltipProvider>
    )
  return { onEvent, onOpenLink, rerender }
}

describe('PluginDeclarativeView', () => {
  it('renders the catalog with accessible roles and fires press callbacks', () => {
    const { onEvent } = view(
      node('Stack', {}, [
        node('Heading', { level: 1 }, ['Tasks']),
        node('Text', { muted: true }, ['3 open ', node('Badge', { tone: 'success' }, ['new'])]),
        node('Button', { onPress: cb('c0'), icon: 'add', variant: 'solid', tone: 'accent' }, [
          'Add'
        ]),
        node('IconButton', { icon: 'delete', label: 'Delete all', onPress: cb('c1') }),
        node('List', { label: 'Task list' }, [
          node('ListItem', { title: 'Write docs', current: true, onPress: cb('c2') }),
          node('ListItem', { title: 'Ship', description: 'Friday' })
        ]),
        node('Progress', { value: 40, label: 'Done' }),
        node('Spinner', { label: 'Syncing' }),
        node('Code', { block: true }, ['pnpm test'])
      ])
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Tasks' })).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
    const list = screen.getByRole('list', { name: 'Task list' })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    const current = screen.getByRole('button', { name: 'Write docs' })
    expect(current.getAttribute('aria-current')).toBe('true')
    fireEvent.click(current)
    expect(onEvent.mock.calls).toEqual([
      ['c0', [], { press: { control: 'Button', gestureId: 'cb:c0', grants: true } }],
      ['c1', [], { press: { control: 'IconButton', gestureId: 'cb:c1', grants: true } }],
      ['c2', [], { press: { control: 'ListItem', gestureId: 'cb:c2', grants: true } }]
    ])
    expect(screen.getByRole('progressbar', { name: 'Done' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Syncing')
    expect(screen.getByText('pnpm test').tagName).toBe('CODE')
  })

  it('keeps typing the guest has not seen, and Enter submits what is on screen', () => {
    const raw = (value: string, edit: number) =>
      node('Input', { label: 'Title', value, $edit: edit, onChange: cb('c0'), onSubmit: cb('c1') })
    const { onEvent, rerender } = view(raw('', 0))
    const input = screen.getByLabelText<HTMLInputElement>('Title')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    // The guest lags: its render has seen edit 1 while the person has typed two.
    rerender(raw('a', 1))
    expect(input.value).toBe('ab')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEvent.mock.calls).toEqual([
      ['c0', ['a'], { edit: 1 }],
      ['c0', ['ab'], { edit: 2 }],
      ['c1', ['ab']]
    ])
    rerender(raw('ab', 2))
    expect(input.value).toBe('ab')
    rerender(raw('', 2))
    expect(input.value).toBe('')
  })

  it('applies a reset to the same value the guest showed before, once it has seen the typing', () => {
    const raw = (value: string, edit: number) =>
      node('Input', { label: 'Title', value, $edit: edit, onChange: cb('c0'), onSubmit: cb('c1') })
    const { rerender } = view(raw('', 0))
    const input = screen.getByLabelText<HTMLInputElement>('Title')
    // Typed "a" and submitted before the echo: the guest clears to "" having seen edit 1.
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    rerender(raw('', 1))
    expect(input.value).toBe('')
  })

  it('seeds an uncontrolled input from defaultValue and makes value-without-onChange read-only', () => {
    view(
      node('Stack', {}, [
        node('Input', { label: 'Draft', defaultValue: 'hi', onChange: cb('c0') }),
        node('Input', { label: 'Fixed', value: 'locked' })
      ])
    )
    expect(screen.getByLabelText<HTMLInputElement>('Draft').value).toBe('hi')
    const fixed = screen.getByLabelText<HTMLInputElement>('Fixed')
    expect(fixed.readOnly).toBe(true)
  })

  it('names a field from a hidden label', () => {
    view(node('Input', { label: 'Search tasks', labelHidden: true, placeholder: 'Search' }))
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toBeTruthy()
  })

  it('toggles a labelled switch', () => {
    const { onEvent } = view(node('Switch', { label: 'Auto refresh', onChange: cb('c0') }))
    const control = screen.getByRole('switch', { name: 'Auto refresh' })
    fireEvent.click(control)
    expect(onEvent).toHaveBeenCalledWith('c0', [true], { edit: 1 })
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('shows the selected option label', () => {
    view(
      node('Select', {
        label: 'Branch',
        value: 'b',
        options: [
          { value: 'a', label: 'main' },
          { value: 'b', label: 'develop' }
        ],
        onChange: cb('c0')
      })
    )
    expect(screen.getByRole('combobox', { name: 'Branch' }).textContent).toContain('develop')
  })

  it('opens links only through the host, with no real href, and without a second grant', () => {
    const { onOpenLink, onEvent } = view(
      node('Text', {}, [
        'See ',
        node('Link', { href: 'https://example.com/docs', onPress: cb('c0') }, ['docs']),
        ' or ',
        node('Link', { onPress: cb('c1') }, ['help'])
      ])
    )
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('href')).toBeNull()
    fireEvent.click(link)
    expect(onOpenLink).toHaveBeenCalledWith(
      'https://example.com/docs',
      'href:https://example.com/docs'
    )
    fireEvent.click(screen.getByRole('link', { name: 'help' }))
    expect(onEvent.mock.calls).toEqual([
      [
        'c0',
        [],
        { press: { control: 'Link', gestureId: 'href:https://example.com/docs', grants: false } }
      ],
      ['c1', [], { press: { control: 'Link', gestureId: 'cb:c1', grants: true } }]
    ])
  })

  it('tracks every granting control on screen under its gesture id', () => {
    const tracked: string[] = []
    const gestures = {
      refFor: (id: string) => (element: Element | null) => {
        if (element) {
          tracked.push(id)
        }
      },
      setContainer: vi.fn(),
      sample: vi.fn(),
      isSettled: () => true
    }
    render(
      <TooltipProvider>
        <PluginDeclarativeView
          tree={tree(
            node('Stack', {}, [
              node('Button', { onPress: cb('c0') }, ['A']),
              node('IconButton', { icon: 'add', label: 'B', onPress: cb('c1') }),
              node('List', {}, [node('ListItem', { title: 'C', onPress: cb('c2') })]),
              node('Text', {}, [node('Link', { href: 'https://x.example' }, ['D'])])
            ])
          )}
          onEvent={vi.fn()}
          gestures={gestures}
        />
      </TooltipProvider>
    )
    expect(tracked.sort()).toEqual(['cb:c0', 'cb:c1', 'cb:c2', 'href:https://x.example'])
    expect(gestures.sample).toHaveBeenCalled()
  })

  it('draws unknown components as a neutral placeholder and unknown icons as a fallback glyph', () => {
    view(
      node('Stack', {}, [
        node('Carousel'),
        node('IconButton', { icon: 'skull', label: 'Odd', onPress: cb('c0') })
      ])
    )
    expect(screen.getByText('Carousel is not available in this version of Orca')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Odd' }).querySelector('svg')).not.toBeNull()
  })

  it('renders an empty state with actions', () => {
    view(
      node('EmptyState', { title: 'No tasks', description: 'Add one to start', icon: 'add' }, [
        node('Button', { variant: 'solid', onPress: cb('c0') }, ['New task'])
      ])
    )
    expect(screen.getByText('No tasks')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy()
  })
})
