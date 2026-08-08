// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

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

function renderDialog(onConfirm: (path: string) => void): {
  nameInput: HTMLInputElement
  dirInput: HTMLInputElement
} {
  render(
    <UntitledFileRenameDialog
      open
      currentName="메모.md"
      worktreePath="/work/repo"
      onClose={() => {}}
      onConfirm={onConfirm}
    />
  )
  const nameInput = screen.getByPlaceholderText('file name') as HTMLInputElement
  const dirInput = screen
    .getAllByRole('textbox')
    .find((node) => node !== nameInput) as HTMLInputElement
  return { nameInput, dirInput }
}

afterEach(cleanup)

describe('UntitledFileRenameDialog IME Enter ownership', () => {
  it('does not write the file on the recorded Korean confirm gesture in the name field', () => {
    const onConfirm = vi.fn()
    const { nameInput } = renderDialog(onConfirm)

    expect(dispatchRecordedGesture(nameInput)).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not write the file on the recorded Korean confirm gesture in the folder field', () => {
    const onConfirm = vi.fn()
    const { dirInput } = renderDialog(onConfirm)

    expect(dispatchRecordedGesture(dirInput)).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('writes exactly once on an ordinary Enter in the name field', () => {
    const onConfirm = vi.fn()
    const { nameInput } = renderDialog(onConfirm)

    dispatchKey(nameInput, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith('메모.md')
  })

  it('writes exactly once on an ordinary Enter in the folder field', () => {
    const onConfirm = vi.fn()
    const { dirInput } = renderDialog(onConfirm)

    dispatchKey(dirInput, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('keeps the two fields independent — a name-field composition does not arm the folder field', () => {
    const onConfirm = vi.fn()
    const { nameInput, dirInput } = renderDialog(onConfirm)

    fireEvent.compositionStart(nameInput)
    dispatchKey(nameInput, 'keydown', {
      key: 'Process',
      code: 'Enter',
      keyCode: 229,
      isComposing: true
    })
    fireEvent.compositionEnd(nameInput, { data: '가' })

    dispatchKey(dirInput, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
