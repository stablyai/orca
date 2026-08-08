// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineInputRow } from './FileExplorerRow'

function dispatchKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

/** macOS 2-Set Korean confirm gesture: the confirming Enter is redispatched unmarked, after keyup. */
function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
  fireEvent.compositionEnd(input, { data: '가' })
  const prevented = dispatchKey(input, 'keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
  return prevented
}

function renderInlineInput(onSubmit: (value: string) => void): HTMLInputElement {
  render(
    <InlineInputRow
      depth={1}
      inlineInput={{ type: 'file', parentPath: '/work/repo', depth: 1 }}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  )
  return screen.getByRole('textbox') as HTMLInputElement
}

afterEach(cleanup)

describe('FileExplorerRow inline input IME Enter ownership', () => {
  it('does not create the file on the recorded Korean confirm gesture', () => {
    const onSubmit = vi.fn()
    const input = renderInlineInput(onSubmit)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('creates exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderInlineInput(onSubmit)
    input.value = '메모.md'

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('메모.md')
  })
})
