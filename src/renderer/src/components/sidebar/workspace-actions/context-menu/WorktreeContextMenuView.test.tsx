// @vitest-environment happy-dom

import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { WORKSPACE_AGENT_ROW_ATTR } from './workspace-agent-row-marker'
import type * as DropdownMenuModule from '@/components/ui/dropdown-menu'

const stub = (name: string) => () => <div data-testid={name} />
// While set, the menu stays mounted after the view closes it, as during its exit animation.
const radixHold = vi.hoisted(() => ({ keepMounted: false }))
vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof DropdownMenuModule>()
  return {
    ...actual,
    DropdownMenu: (props: React.ComponentProps<typeof actual.DropdownMenu>) => (
      <actual.DropdownMenu {...props} open={props.open || radixHold.keepMounted} />
    )
  }
})
vi.mock('./WorktreeContextMenuDeleteItems', () => ({
  WorktreeContextMenuDeleteItems: stub('delete-items')
}))
vi.mock('./WorktreeNotificationMuteMenuItem', () => ({
  WorktreeNotificationMuteMenuItem: stub('mute-item')
}))
vi.mock('./WorktreeContextMenuOverlays', () => ({ WorktreeContextMenuOverlays: () => null }))
vi.mock('./WorktreeContextMenuSubMenus', () => ({
  WorktreeCopySubMenu: () => null,
  WorktreeLineageSubMenu: () => null,
  WorktreeProjectGroupSubMenu: () => null
}))
vi.mock('../open/WorktreeRowOpenInSubMenu', () => ({ WorktreeRowOpenInSubMenu: () => null }))
vi.mock('../open/WorktreeDeveloperMenu', () => ({ WorktreeDeveloperMenu: () => null }))
vi.mock('../sleep/WorkspaceVmLifecycleMenuItems', () => ({
  WorkspaceVmLifecycleMenuItems: stub('sleep-items')
}))
vi.mock('../sleep/WorkspaceSleepMenuItems', () => ({ WorkspaceSleepMenuItems: () => null }))
vi.mock('../../workspace-status/presentation/WorktreeStatusMenuItems', () => ({
  WorktreeStatusMenuItems: () => null
}))
vi.mock('../../workspace-card/host/WorktreeWslHostStartMenuItem', () => ({
  WorktreeWslHostStartMenuItem: () => null
}))
vi.mock('@/components/wsl-move/WslMovedUseHereMenuItem', () => ({
  WslMovedWorkspaceUseHereMenuItem: () => null
}))
vi.mock('@/components/wsl-move/WslMoveProjectMenuItem', () => ({
  WslMoveFolderWorkspaceMenuItem: () => null
}))
vi.mock('@/components/bots/hand-to-bot/WorktreeHandToBotMenuItem', () => ({
  WorktreeHandToBotMenuItem: () => null
}))

const { default: WorktreeContextMenuView } = await import('./WorktreeContextMenuView')

const noop = (): void => {}

function Card({ isMultiContext = false }: { isMultiContext?: boolean }): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const scopeRef = useRef<HTMLDivElement>(null)
  const contextMenuOpenedAtRef = useRef<number | null>(null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stub model holding only the fields this view reads; its heavy children are mocked.
  const model = {
    children: (
      <div>
        <div data-testid="header">payoption_opt</div>
        <div data-testid="expander">2 agents</div>
        <div data-testid="agent-row" {...{ [WORKSPACE_AGENT_ROW_ATTR]: 'true' }}>
          Continue work
          <button type="button" data-testid="agent-row-control">
            x
          </button>
        </div>
      </div>
    ),
    contentClassName: undefined,
    contextMenuOpenedAtRef,
    contextWorkspaceStatus: null,
    deletingContext: false,
    deletingSubtree: false,
    developerMenuRevealed: false,
    effectiveSelectedWorktrees: [],
    folderWorkspaceId: null,
    handleAssignWorkspaceStatus: noop,
    handleCloseAutoFocus: noop,
    handleCloseTerminals: noop,
    handleRemoveParentLink: noop,
    handleRename: noop,
    handleSleepSubtree: noop,
    handleSleepSubtreeWithVm: noop,
    handleTogglePin: noop,
    handleToggleRead: noop,
    showsUnread: false,
    hasAnyContextLineage: false,
    isDeleting: false,
    isMultiContext,
    lineageDescendantCount: 0,
    menuOpen,
    menuPoint,
    onContextMenuSelect: undefined,
    repo: null,
    scopeRef,
    setContextWorktrees: noop,
    setDeveloperMenuRevealed: noop,
    setMenuOpenState: setMenuOpen,
    setMenuPoint,
    sleepLabel: 'Sleep',
    sleepableWorktrees: [],
    subtreeSleepableWorktrees: [],
    suppressOpeningPointerEvent: noop,
    worktree: { id: 'repo::/w', isPinned: false },
    workspaceStatuses: []
  } as unknown as WorktreeContextMenuModel
  return (
    <>
      <button type="button" data-testid="close-menu" onClick={() => setMenuOpen(false)} />
      <WorktreeContextMenuView model={model} />
    </>
  )
}

function openFrom(testId: string): void {
  act(() => {
    fireEvent.contextMenu(screen.getByTestId(testId))
  })
}

function close(): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
}

afterEach(() => {
  cleanup()
  radixHold.keepMounted = false
})

describe('WorktreeContextMenuView from an agent row', () => {
  it('opens the workspace menu without Delete', () => {
    render(<Card />)
    openFrom('agent-row')
    expect(screen.getByTestId('mute-item')).toBeTruthy()
    expect(screen.getByTestId('sleep-items')).toBeTruthy()
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('treats a control inside the row (keyboard-opened menus target it) as the row', () => {
    render(<Card />)
    openFrom('agent-row-control')
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('keeps Delete from the header and the agents expander', () => {
    render(<Card />)
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    openFrom('expander')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
  })

  it('decides on every open, in either order', () => {
    render(<Card />)
    openFrom('agent-row')
    expect(screen.queryByTestId('delete-items')).toBeNull()
    close()
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    openFrom('agent-row')
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('keeps Delete out while a row-opened menu is still mounted after closing', () => {
    render(<Card />)
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    openFrom('agent-row')
    radixHold.keepMounted = true
    act(() => {
      screen.getByTestId('close-menu').click()
    })
    expect(screen.getByTestId('mute-item')).toBeTruthy()
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('omits the batch Delete of a multi-selection too', () => {
    render(<Card isMultiContext />)
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    openFrom('agent-row')
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })
})
