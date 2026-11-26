// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeCodeInput } from './PluginDeclarativeCodeInput'

// The suggestions render inline, so the test reads them without a portal or positioning.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-open={open}>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

type Props = PluginDeclarativeProps<'CodeInput'>

const base: Props = {
  label: 'Filter',
  completions: [{ label: 'total' }],
  onChange: { $callback: 'change' }
}

beforeEach(() => {
  // happy-dom has no editing commands; the component falls back to setting the value itself.
  document.execCommand = vi.fn(() => false)
})

afterEach(cleanup)

function rendered(): HTMLTextAreaElement {
  const textarea = screen.getByRole('combobox')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('CodeInput did not render a textarea')
  }
  return textarea
}

function field(props: Props): { textarea: HTMLTextAreaElement; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  render(<PluginDeclarativeCodeInput props={props} emit={emit} />)
  return { textarea: rendered(), emit }
}

function placeCaret(textarea: HTMLTextAreaElement, at: number): void {
  textarea.focus()
  textarea.setSelectionRange(at, at)
  fireEvent.select(textarea)
}

function suggest(textarea: HTMLTextAreaElement, at: number): void {
  placeCaret(textarea, at)
  fireEvent.keyDown(textarea, { key: ' ', ctrlKey: true })
}

it('replaces the word at the caret with the chosen suggestion', () => {
  const { textarea } = field({ ...base, defaultValue: 'to + status' })
  suggest(textarea, 2)
  expect(screen.getByRole('option').textContent).toBe('total')
  fireEvent.keyDown(textarea, { key: 'Tab' })
  expect(textarea.value).toBe('total + status')
})

it('drops suggestions once the caret leaves the word', () => {
  const { textarea } = field({ ...base, defaultValue: 'to + status', rows: 2 })
  suggest(textarea, 2)
  placeCaret(textarea, 11)
  expect(screen.queryByRole('option')).toBeNull()
  fireEvent.keyDown(textarea, { key: 'Enter' })
  expect(textarea.value).toBe('to + status\n')
})

it('does not replace other text when the caret moved without a select event', () => {
  const { textarea } = field({ ...base, defaultValue: 'to + status' })
  suggest(textarea, 2)
  textarea.setSelectionRange(11, 11)
  fireEvent.keyDown(textarea, { key: 'Tab' })
  expect(textarea.value).toBe('to + status')
})

it('breaks the line on Shift+Enter while suggestions are open', () => {
  const { textarea } = field({ ...base, defaultValue: 'to + status', rows: 2 })
  suggest(textarea, 2)
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
  expect(textarea.value).toBe('to\n + status')
  expect(screen.queryByRole('option')).toBeNull()
})

it('hides uncontrolled diagnostics after an edit until the guest has seen it', () => {
  const props: Props = {
    ...base,
    defaultValue: 'abc',
    diagnostics: [{ from: 0, to: 3, message: 'bad' }],
    $edit: 0
  }
  const emit = vi.fn()
  const { container, rerender } = render(<PluginDeclarativeCodeInput props={props} emit={emit} />)
  const underlines = (): number => container.querySelectorAll('[data-tone]').length
  expect(underlines()).toBe(1)

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '\nabc' } })
  expect(emit).toHaveBeenCalledWith('change', ['\nabc'], { edit: 1 })
  expect(underlines()).toBe(0)

  rerender(<PluginDeclarativeCodeInput props={{ ...props }} emit={emit} />)
  expect(underlines()).toBe(0)

  rerender(
    <PluginDeclarativeCodeInput
      props={{ ...props, diagnostics: [{ from: 1, to: 4, message: 'bad' }], $edit: 1 }}
      emit={emit}
    />
  )
  expect(underlines()).toBe(1)
})

it('hides diagnostics for good after an edit the guest cannot hear', () => {
  const { onChange: _, ...rest } = base
  const { textarea } = field({
    ...rest,
    defaultValue: 'abc',
    diagnostics: [{ from: 0, to: 3, message: 'bad' }]
  })
  expect(document.querySelectorAll('[data-tone]').length).toBe(1)
  fireEvent.change(textarea, { target: { value: 'abcd' } })
  expect(document.querySelectorAll('[data-tone]').length).toBe(0)
})

it('numbers edits past what the guest saw before a remount', () => {
  const props: Props = {
    ...base,
    defaultValue: 'abc',
    diagnostics: [{ from: 0, to: 3, message: 'bad' }],
    $edit: 5
  }
  const emit = vi.fn()
  const { container, rerender } = render(<PluginDeclarativeCodeInput props={props} emit={emit} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'abcd' } })
  expect(emit).toHaveBeenCalledWith('change', ['abcd'], { edit: 6 })
  rerender(<PluginDeclarativeCodeInput props={{ ...props }} emit={emit} />)
  expect(container.querySelectorAll('[data-tone]').length).toBe(0)
})

it('counts offsets on CRLF text the way the textarea does', () => {
  const { textarea } = field({ ...base, completions: [{ label: '$gt' }], defaultValue: 'a\r\n$g' })
  suggest(textarea, 4)
  fireEvent.keyDown(textarea, { key: 'Tab' })
  expect(textarea.value).toBe('a\n$gt')
})

it('offers every suggestion on Ctrl+Space and still replaces the typed word', () => {
  const { textarea } = field({
    ...base,
    completions: [{ label: 'name' }, { label: 'total' }],
    defaultValue: 'zz'
  })
  suggest(textarea, 2)
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'name',
    'total'
  ])
  fireEvent.keyDown(textarea, { key: 'Tab' })
  expect(textarea.value).toBe('name')
})

it('still filters suggestions while typing', () => {
  const { textarea } = field({ ...base, completions: [{ label: 'name' }, { label: 'total' }] })
  textarea.focus()
  fireEvent.input(textarea, { target: { value: 'na' }, inputType: 'insertText', data: 'a' })
  expect(screen.queryAllByRole('option').map((option) => option.textContent)).toEqual(['name'])
})

it('drops suggestions opened on text the guest has since replaced', () => {
  const props: Props = { ...base, completions: [{ label: 'name' }], value: 'na' }
  const emit = vi.fn()
  const { rerender } = render(<PluginDeclarativeCodeInput props={props} emit={emit} />)
  const textarea = rendered()
  suggest(textarea, 2)
  expect(screen.getByRole('option').textContent).toBe('name')
  rerender(<PluginDeclarativeCodeInput props={{ ...props, value: '{}' }} emit={emit} />)
  placeCaret(textarea, 2)
  expect(screen.queryByRole('option')).toBeNull()
  fireEvent.keyDown(textarea, { key: 'Tab' })
  expect(textarea.value).toBe('{}')
})
