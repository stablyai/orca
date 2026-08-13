// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: Radix menus never open under happy-dom, so the primitives pass through and the
// items render inline where the test can click them.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { EmulatorDeviceActionsMenu } from './emulator-device-actions-menu'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderMenu(props: {
  disabled?: boolean
  onButton?: (name: string) => void
  onBiometric?: (action: string) => void
}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EmulatorDeviceActionsMenu
        disabled={props.disabled ?? false}
        onButton={props.onButton ?? vi.fn()}
        onBiometric={props.onBiometric ?? vi.fn()}
      />
    )
  })
}

function clickItem(label: string): void {
  const item = [...(container?.querySelectorAll('button') ?? [])].find(
    (node) => node.textContent === label
  )
  if (!item) {
    throw new Error(`no menu item labelled "${label}"`)
  }
  act(() => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('EmulatorDeviceActionsMenu', () => {
  it('sends side_button, which the iOS backend maps to the lock button', () => {
    const onButton = vi.fn()
    renderMenu({ onButton })
    clickItem('Side Button')
    expect(onButton).toHaveBeenCalledWith('side_button')
  })

  it('sends the other hardware buttons', () => {
    const onButton = vi.fn()
    renderMenu({ onButton })
    clickItem('Siri')
    clickItem('App Switcher')
    expect(onButton).toHaveBeenNthCalledWith(1, 'siri')
    expect(onButton).toHaveBeenNthCalledWith(2, 'app_switcher')
  })

  it('sends every biometric action', () => {
    const onBiometric = vi.fn()
    renderMenu({ onBiometric })
    clickItem('Enrolled')
    clickItem('Not Enrolled')
    clickItem('Matching Face')
    clickItem('Non-matching Face')
    expect(onBiometric.mock.calls.flat()).toEqual(['enroll', 'unenroll', 'match', 'nomatch'])
  })

  it('disables the trigger while the stream is not live', () => {
    renderMenu({ disabled: true })
    const trigger = container?.querySelector('button[aria-label="More device actions"]')
    expect(trigger).not.toBeNull()
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
  })
})
