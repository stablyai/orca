// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionContextMenuPayload } from '../../../../../shared/browser-extension-context-menu-types'
import { BrowserPageExtensionMenuItems } from './browser-page-extension-menu-items'

const VAULT = 'a'.repeat(32)
const NOTES = 'b'.repeat(32)
const leaf = (key: string, title: string) => ({
  key,
  title,
  type: 'normal' as const,
  checked: false,
  enabled: true,
  children: []
})

const menu: BrowserExtensionContextMenuPayload = {
  token: 'token-1',
  groups: [
    { extensionId: NOTES, items: [leaf('7', 'Save to notes')] },
    {
      extensionId: VAULT,
      items: [
        {
          ...leaf('', 'Vault'),
          children: [
            leaf('"fill"', 'Fill'),
            { ...leaf('"remember"', 'Remember'), type: 'checkbox', checked: true }
          ]
        }
      ]
    }
  ]
}

let root: Root
let container: HTMLDivElement
const click = vi.fn(async () => true)
const done = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.assign(window, { api: { browser: { extensionsContextMenuClick: click } } })
  act(() => {
    root.render(<BrowserPageExtensionMenuItems menu={menu} itemClassName="item" onDone={done} />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  click.mockClear()
  done.mockClear()
})

function item(name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (element) => element.textContent?.trim() === name
  )
  if (!found) {
    throw new Error(`No menu item ${name}`)
  }
  return found
}

describe('extension items in the page context menu', () => {
  it('shows a single item inline and several under the extension submenu', () => {
    expect(item('Save to notes').getAttribute('aria-haspopup')).toBeNull()
    expect(item('Vault').getAttribute('aria-haspopup')).toBe('menu')
    expect(container.textContent).not.toContain('Fill')

    act(() => item('Vault').click())
    expect(item('Fill')).toBeTruthy()
    expect(item('Remember').getAttribute('role')).toBe('menuitemcheckbox')
    expect(item('Remember').getAttribute('aria-checked')).toBe('true')
  })

  it('sends the token, extension and item key, then closes the menu', () => {
    act(() => item('Vault').click())
    act(() => item('Fill').click())
    expect(click).toHaveBeenCalledWith({ token: 'token-1', extensionId: VAULT, key: '"fill"' })
    expect(done).toHaveBeenCalledTimes(1)
  })
})
