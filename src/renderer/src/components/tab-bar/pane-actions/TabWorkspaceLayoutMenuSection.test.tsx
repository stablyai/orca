import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'

const mocks = vi.hoisted(() => {
  const state: { keybindings: KeybindingOverrides } = { keybindings: {} }
  return state
})

vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: (select: (state: { keybindings: KeybindingOverrides }) => unknown) =>
    select({ keybindings: mocks.keybindings })
}))
vi.mock('./tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: () => true,
  moveTabToNewPaneColumn: vi.fn()
}))
// Radix renders submenu content only while open; plain wrappers expose every item to static markup.
vi.mock('@/components/ui/context-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSubTrigger: Pass,
    ContextMenuItem: ({ children }: { children?: ReactNode }) => (
      <div role="menuitem">{children}</div>
    ),
    ContextMenuShortcut: ({ children }: { children?: ReactNode }) => <kbd>{children}</kbd>
  }
})
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))

function renderShortcuts(): string[] {
  const markup = renderToStaticMarkup(
    <TabWorkspaceLayoutMenuSection unifiedTabId="tab-a" groupId="group-1" />
  )
  return [...markup.matchAll(/<div role="menuitem">(.*?)<\/div>/g)].map(
    ([, item]) => /<kbd>(.*?)<\/kbd>/.exec(item)?.[1] ?? ''
  )
}

describe('TabWorkspaceLayoutMenuSection shortcuts', () => {
  beforeEach(() => {
    mocks.keybindings = {}
  })

  it('shows no shortcut while the move-to-split actions are unbound', () => {
    expect(renderShortcuts()).toEqual(['', '', '', ''])
  })

  it('shows each bound chord on its own direction', () => {
    mocks.keybindings = {
      'tab.moveToSplitLeft': ['Mod+Alt+ArrowLeft'],
      'tab.moveToSplitUp': ['Mod+Alt+ArrowUp']
    }
    expect(renderShortcuts()).toEqual(['', 'Ctrl+Alt+←', '', 'Ctrl+Alt+↑'])
  })
})
