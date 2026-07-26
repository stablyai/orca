// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'

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

function renderDialog(onSubmit: () => void): HTMLInputElement {
  act(() => {
    root.render(
      <ProjectGroupNameDialog
        open={true}
        title="Rename Project Group"
        description="Name this group."
        initialName="グループ"
        confirmLabel="Save"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />
    )
  })
  const input = document.body.querySelector('input')
  if (!input) {
    throw new Error('group name input not rendered')
  }
  return input
}

function pressEnter(
  input: HTMLInputElement,
  init?: KeyboardEventInit & { keyCode?: number }
): KeyboardEvent {
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
  return event
}

describe('ProjectGroupNameDialog IME Enter guard', () => {
  it('cancels the implicit form submit on an IME-composition Enter (isComposing)', () => {
    const onSubmit = vi.fn()
    const input = renderDialog(onSubmit)

    const event = pressEnter(input, { isComposing: true })

    expect(event.defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels it for IMEs that report keyCode 229 without isComposing', () => {
    const onSubmit = vi.fn()
    const input = renderDialog(onSubmit)

    const event = pressEnter(input, { keyCode: 229 })

    expect(event.defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('leaves a plain Enter alone so the form still submits', () => {
    const onSubmit = vi.fn()
    const input = renderDialog(onSubmit)

    const event = pressEnter(input)

    expect(event.defaultPrevented).toBe(false)
  })

  it('still saves the trimmed name when the form submits', () => {
    const onSubmit = vi.fn()
    renderDialog(onSubmit)
    const form = document.body.querySelector('form')
    if (!form) {
      throw new Error('form not rendered')
    }

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith('グループ')
  })
})
