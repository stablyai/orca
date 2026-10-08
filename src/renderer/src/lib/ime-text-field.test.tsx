// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { ImeInput, ImeTextarea } from './ime-text-field'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const enter = { key: 'Enter', keyCode: 13 }

describe.each([Input, Textarea, ImeInput, ImeTextarea])('IME text field %s', (Field) => {
  it.each([
    { marked: { key: 'Enter', keyCode: 13, isComposing: true }, release: enter },
    { marked: { key: 'Enter', keyCode: 229 }, release: enter },
    { marked: { key: 'Process', keyCode: 229 }, release: enter },
    {
      marked: { key: 'Process', keyCode: 229 },
      release: { key: 'Process', keyCode: 229 }
    }
  ])(
    'keeps a marked confirmation and its redispatch out of field and parent actions: %j',
    ({ marked, release }) => {
      const action = vi.fn()
      const parentAction = vi.fn()
      const { getByRole } = render(
        <div onKeyDown={parentAction}>
          <Field onKeyDown={action} />
        </div>
      )
      const field = getByRole('textbox')
      expect(fireEvent.keyDown(field, marked)).toBe(true)
      fireEvent.keyUp(field, release)
      expect(fireEvent.keyDown(field, enter)).toBe(false)
      expect(action).not.toHaveBeenCalled()
      expect(parentAction).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(field, enter)
      expect(action).toHaveBeenCalledOnce()
      expect(parentAction).toHaveBeenCalledOnce()
    }
  )

  it('guards active composition, preserves lifecycle callbacks, and releases on blur', () => {
    const action = vi.fn()
    const start = vi.fn(),
      end = vi.fn(),
      blur = vi.fn(),
      up = vi.fn()
    const { getByRole } = render(
      <Field
        onKeyDown={action}
        onCompositionStart={start}
        onCompositionEnd={end}
        onBlur={blur}
        onKeyUp={up}
      />
    )
    const field = getByRole('textbox')
    fireEvent.compositionStart(field)
    for (const key of ['Enter', 'Escape', 'ArrowDown']) {
      expect(fireEvent.keyDown(field, { key, keyCode: key === 'Enter' ? 13 : 0 })).toBe(true)
    }
    expect(action).not.toHaveBeenCalled()
    fireEvent.compositionEnd(field)
    fireEvent.keyUp(field, enter)
    fireEvent.blur(field)
    fireEvent.keyDown(field, enter)
    expect(action).toHaveBeenCalledOnce()
    for (const callback of [start, end, blur, up]) {
      expect(callback).toHaveBeenCalledOnce()
    }
  })

  it('preserves ordinary keys, Shift+Enter, and modifier submits after a confirmation', () => {
    const action = vi.fn()
    const { getByRole } = render(<Field onKeyDown={action} />)
    const field = getByRole('textbox')
    fireEvent.keyDown(field, { ...enter, keyCode: 229 })
    expect(fireEvent.keyDown(field, { ...enter, shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(field, { ...enter, ctrlKey: true })).toBe(true)
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.keyDown(field, { key: 'a' })
    expect(action).toHaveBeenCalledTimes(4)
  })

  it('does not carry ownership into a replaced field', () => {
    const action = vi.fn()
    const { getByRole, rerender } = render(<Field key="first" onKeyDown={action} />)
    fireEvent.compositionStart(getByRole('textbox'))
    fireEvent.keyDown(getByRole('textbox'), { ...enter, keyCode: 229 })
    rerender(<Field key="second" onKeyDown={action} />)
    fireEvent.keyDown(getByRole('textbox'), enter)
    expect(action).toHaveBeenCalledOnce()
  })

  it('accepts deliberate Enter after continued typing without waiting for a frame', () => {
    const action = vi.fn()
    const { getByRole } = render(<Field onKeyDown={action} />)
    const field = getByRole('textbox')
    fireEvent.keyDown(field, { ...enter, keyCode: 229 })
    fireEvent.keyUp(field, enter)
    fireEvent.keyDown(field, { key: '.', keyCode: 190 })
    fireEvent.keyUp(field, { key: '.', keyCode: 190 })
    fireEvent.keyDown(field, enter)
    expect(action).toHaveBeenCalledTimes(2)
  })
})

it('does not select a command when Enter confirms an IME candidate', () => {
  const select = vi.fn()
  const { getByRole } = render(
    <Command>
      <CommandInput />
      <CommandList>
        <CommandItem value="item" onSelect={select}>
          Item
        </CommandItem>
      </CommandList>
    </Command>
  )
  const field = getByRole('combobox')
  fireEvent.keyDown(field, { ...enter, keyCode: 229 })
  fireEvent.keyDown(field, enter)
  expect(select).not.toHaveBeenCalled()
  fireEvent.keyUp(field, enter)
  vi.advanceTimersByTime(20)
  fireEvent.keyDown(field, enter)
  expect(select).toHaveBeenCalledOnce()
})
