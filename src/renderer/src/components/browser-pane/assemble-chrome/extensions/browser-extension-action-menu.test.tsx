// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { BrowserExtensionContextMenuItem } from '../../../../../../shared/browser/extensions/browser-extension-context-menu-types'
import type { BrowserExtensionToolbarAction } from '../../../../../../shared/browser/extensions/browser-extension-toolbar-types'

function leaf(
  key: string,
  type: BrowserExtensionContextMenuItem['type'],
  checked: boolean
): BrowserExtensionContextMenuItem {
  return { key, title: key, type, checked, enabled: true, children: [] }
}

vi.mock('./browser-extension-action-context-items', () => ({
  useBrowserExtensionActionContextMenu: () => ({
    token: 'token',
    groups: [
      {
        extensionId: 'ext',
        items: [
          leaf('Plain', 'normal', false),
          leaf('On', 'checkbox', true),
          leaf('Off', 'checkbox', false),
          leaf('Picked', 'radio', true)
        ]
      }
    ]
  })
}))

import {
  BrowserExtensionContextEntries,
  BrowserExtensionDropdownEntries,
  useBrowserExtensionActionMenuEntries
} from './browser-extension-action-menu'

const action: BrowserExtensionToolbarAction = {
  extensionId: 'ext',
  name: 'Ext',
  title: 'Ext',
  iconDataUrl: null,
  badgeText: '',
  badgeBackgroundColor: null,
  badgeTextColor: null,
  enabled: true,
  hasPopup: false,
  pinned: false,
  hasOptionsPage: false,
  source: 'webstore'
}

function Entries({ kind }: { kind: 'dropdown' | 'context' }): React.JSX.Element {
  const entries = useBrowserExtensionActionMenuEntries('profile', action, 'page')
  return kind === 'dropdown' ? (
    <BrowserExtensionDropdownEntries entries={entries} />
  ) : (
    <BrowserExtensionContextEntries entries={entries} />
  )
}

const declineConfirm = (): Promise<boolean> => Promise.resolve(false)

afterEach(cleanup)

describe('extension action menu entries', () => {
  it.each(['dropdown', 'context'] as const)(
    'exposes checkbox and radio semantics in the %s menu',
    (kind) => {
      render(
        <ConfirmationDialogContext.Provider value={declineConfirm}>
          {kind === 'dropdown' ? (
            <DropdownMenu open>
              <DropdownMenuTrigger>menu</DropdownMenuTrigger>
              <DropdownMenuContent>
                <Entries kind={kind} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger>menu</ContextMenuTrigger>
              <ContextMenuContent>
                <Entries kind={kind} />
              </ContextMenuContent>
            </ContextMenu>
          )}
        </ConfirmationDialogContext.Provider>
      )
      if (kind === 'context') {
        fireEvent.contextMenu(screen.getByText('menu'))
      }

      expect(screen.getByRole('menuitem', { name: 'Plain' })).not.toHaveAttribute('aria-checked')
      expect(screen.getByRole('menuitemcheckbox', { name: 'On' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      expect(screen.getByRole('menuitemcheckbox', { name: 'Off' })).toHaveAttribute(
        'aria-checked',
        'false'
      )
      expect(screen.getByRole('menuitemradio', { name: 'Picked' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
    }
  )
})
