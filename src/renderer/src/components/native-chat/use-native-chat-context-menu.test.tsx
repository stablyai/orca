// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => children
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    )
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function actions(overrides: Partial<NativeChatContextMenuActions>): NativeChatContextMenuActions {
  return {
    onPaste: vi.fn(),
    canSplitPane: true,
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    canEqualizePaneSizes: false,
    onEqualizePaneSizes: vi.fn(),
    canExpandPane: false,
    isPaneExpanded: false,
    onToggleExpand: vi.fn(),
    onForkAgentSession: vi.fn(),
    onSetTitle: vi.fn(),
    onCopyTerminalId: vi.fn(),
    onCopyPaneId: vi.fn(),
    canClosePane: false,
    onClosePane: vi.fn(),
    ...overrides
  }
}

function ContextMenuHarness({ menuActions }: { menuActions: NativeChatContextMenuActions }) {
  const rootRef = createRef<HTMLElement>()
  const { menu } = useNativeChatContextMenu({ rootRef, actions: menuActions })
  return <section ref={rootRef}>{menu}</section>
}

describe('useNativeChatContextMenu split policy', () => {
  it('omits native-chat split affordances for maintained grids', () => {
    const view = render(<ContextMenuHarness menuActions={actions({ canSplitPane: false })} />)

    expect(view.queryByRole('button', { name: 'Split Terminal Right' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Split Terminal Down' })).toBeNull()
  })

  it('retains enabled native-chat split affordances for ordinary tabs', () => {
    const onSplitRight = vi.fn()
    const onSplitDown = vi.fn()
    const view = render(
      <ContextMenuHarness
        menuActions={actions({ canSplitPane: true, onSplitRight, onSplitDown })}
      />
    )

    view.getByRole('button', { name: 'Split Terminal Right' }).click()
    view.getByRole('button', { name: 'Split Terminal Down' }).click()
    expect(onSplitRight).toHaveBeenCalledOnce()
    expect(onSplitDown).toHaveBeenCalledOnce()
  })
})
