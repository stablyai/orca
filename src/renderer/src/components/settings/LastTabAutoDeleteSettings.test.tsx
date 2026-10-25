// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { LastTabAutoDeleteMode } from '../../../../shared/worktree-deletion-preferences'
import { LastTabAutoDeleteSettings } from './LastTabAutoDeleteSettings'

// Why a native select: the Radix popover does not open under happy-dom.
vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select aria-label="mode" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(
  mode: LastTabAutoDeleteMode | undefined,
  updateSettings: (updates: Partial<GlobalSettings>) => void
): void {
  const settings = getDefaultSettings('/home/user')
  settings.deleteWorkspaceOnLastTabClose = mode
  act(() => {
    root.render(<LastTabAutoDeleteSettings settings={settings} updateSettings={updateSettings} />)
  })
}

function skipSwitch(label: string): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!control) {
    throw new Error(`switch not found: ${label}`)
  }
  return control
}

describe('LastTabAutoDeleteSettings', () => {
  it('writes the chosen mode', () => {
    const updateSettings = vi.fn()
    render('off', updateSettings)
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="mode"]')
    act(() => {
      select!.value = 'close-or-exit'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ deleteWorkspaceOnLastTabClose: 'close-or-exit' })
  })

  it('disables the skip switches while off, including for settings saved before the field', () => {
    render(undefined, vi.fn())
    for (const label of [
      'Skip Pinned Workspaces',
      'Skip Folder Workspaces',
      'Skip SSH Workspaces'
    ]) {
      expect(skipSwitch(label).disabled).toBe(true)
    }
  })

  it('toggles skip-pinned from its default of on', () => {
    const updateSettings = vi.fn()
    render('close', updateSettings)
    const pinned = skipSwitch('Skip Pinned Workspaces')
    expect(pinned.disabled).toBe(false)
    act(() => pinned.click())
    expect(updateSettings).toHaveBeenCalledWith({ lastTabDeleteSkipPinned: false })
  })
})
