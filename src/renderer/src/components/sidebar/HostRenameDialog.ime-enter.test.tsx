// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostRenameDialog } from './HostRenameDialog'

const { updateSettings } = vi.hoisted(() => ({ updateSettings: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: {}, updateSettings })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  updateSettings.mockClear()
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

function renderDialog(onOpenChange: (open: boolean) => void): HTMLInputElement {
  act(() => {
    root.render(
      <HostRenameDialog
        open={true}
        onOpenChange={onOpenChange}
        hostId="local"
        derivedLabel="This Mac"
      />
    )
  })
  const input = document.body.querySelector<HTMLInputElement>('#host-rename-input')
  if (!input) {
    throw new Error('host rename input not rendered')
  }
  return input
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

describe('HostRenameDialog IME Enter guard', () => {
  it('does not commit the rename on an IME-composition Enter', () => {
    const onOpenChange = vi.fn()
    const input = renderDialog(onOpenChange)

    pressEnter(input, { isComposing: true })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not commit it for IMEs that report keyCode 229 without isComposing', () => {
    const onOpenChange = vi.fn()
    const input = renderDialog(onOpenChange)

    pressEnter(input, { keyCode: 229 })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('still commits the rename on a plain Enter', () => {
    const onOpenChange = vi.fn()
    const input = renderDialog(onOpenChange)

    pressEnter(input)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
