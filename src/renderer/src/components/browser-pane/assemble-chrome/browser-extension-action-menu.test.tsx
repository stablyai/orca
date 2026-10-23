// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import type { BrowserExtensionContextMenuPayload } from '../../../../../shared/browser-extension-context-menu-types'
import type { BrowserExtensionToolbarAction } from '../../../../../shared/browser-extension-toolbar-types'
import {
  BrowserExtensionDropdownEntries,
  useBrowserExtensionActionMenuEntries
} from './browser-extension-action-menu'

const EXTENSION_ID = 'a'.repeat(32)
const action: BrowserExtensionToolbarAction = {
  extensionId: EXTENSION_ID,
  name: 'Notes',
  title: 'Notes',
  iconDataUrl: null,
  badgeText: '',
  badgeBackgroundColor: null,
  badgeTextColor: null,
  enabled: true,
  hasPopup: false,
  pinned: true,
  hasOptionsPage: false,
  source: 'unpacked'
}
const menu: BrowserExtensionContextMenuPayload = {
  token: 'token-1',
  groups: [
    {
      extensionId: EXTENSION_ID,
      items: [
        {
          key: '"save"',
          title: 'Save page',
          type: 'normal',
          checked: false,
          enabled: true,
          children: []
        }
      ]
    }
  ]
}

const declineConfirmation = async (): Promise<boolean> => false

function OpenActionMenu(): React.JSX.Element {
  const entries = useBrowserExtensionActionMenuEntries('default', action, 'page-1')
  return (
    <DropdownMenu open>
      <DropdownMenuContent>
        <BrowserExtensionDropdownEntries entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

let root: Root
let container: HTMLDivElement
const fetchMenu = vi.fn(async () => menu)
const click = vi.fn(async () => true)

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.assign(window, {
    api: { browser: { extensionsActionContextMenu: fetchMenu, extensionsContextMenuClick: click } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  fetchMenu.mockClear()
  click.mockClear()
})

describe('extension action menu', () => {
  it("shows the extension's action items and clicks them through main's snapshot", async () => {
    await act(async () => {
      root.render(
        <ConfirmationDialogContext.Provider value={declineConfirmation}>
          <OpenActionMenu />
        </ConfirmationDialogContext.Provider>
      )
    })

    expect(fetchMenu).toHaveBeenCalledWith({
      profileId: 'default',
      extensionId: EXTENSION_ID,
      browserPageId: 'page-1'
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === 'Save page'
    )
    expect(item).toBeDefined()
    act(() => item?.click())
    expect(click).toHaveBeenCalledWith({
      token: 'token-1',
      extensionId: EXTENSION_ID,
      key: '"save"'
    })
  })
})
