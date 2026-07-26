// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderDialog(onConfirm: (relativePath: string) => void): {
  nameInput: HTMLInputElement
  folderInput: HTMLInputElement
} {
  act(() => {
    root.render(
      <UntitledFileRenameDialog
        open={true}
        currentName="議事録"
        worktreePath="/repo"
        disableBrowse
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )
  })
  const inputs = Array.from(document.body.querySelectorAll('input'))
  if (inputs.length < 2) {
    throw new Error('rename dialog inputs not rendered')
  }
  return { nameInput: inputs[0], folderInput: inputs[1] }
}

function pressEnter(
  input: HTMLInputElement,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

describe('UntitledFileRenameDialog IME Enter guard', () => {
  it('does not save the file on an IME-composition Enter in the name field', () => {
    const onConfirm = vi.fn()
    const { nameInput } = renderDialog(onConfirm)

    pressEnter(nameInput, { isComposing: true })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not save it for IMEs that report keyCode 229 without isComposing', () => {
    const onConfirm = vi.fn()
    const { nameInput } = renderDialog(onConfirm)

    pressEnter(nameInput, { keyCode: 229 })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not save the file on an IME-composition Enter in the folder field', () => {
    const onConfirm = vi.fn()
    const { folderInput } = renderDialog(onConfirm)

    pressEnter(folderInput, { isComposing: true })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('still saves on a plain Enter', () => {
    const onConfirm = vi.fn()
    const { nameInput } = renderDialog(onConfirm)

    pressEnter(nameInput)

    expect(onConfirm).toHaveBeenCalledWith('議事録.md')
  })
})
