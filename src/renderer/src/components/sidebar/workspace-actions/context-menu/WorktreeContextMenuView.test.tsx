// @vitest-environment happy-dom

import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { WORKSPACE_AGENT_ROW_ATTR } from './workspace-agent-row-marker'

const stub = (name: string) => () => <div data-testid={name} />
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
  return <WorktreeContextMenuView model={model} />
}

/** Right-clicks a part of the card; true when the card left the event to that part. */
function openFrom(testId: string): boolean {
  let unhandled = true
  act(() => {
    unhandled = fireEvent.contextMenu(screen.getByTestId(testId))
  })
  return unhandled
}

function close(): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
}

afterEach(() => {
  cleanup()
})

describe('WorktreeContextMenuView and agent rows', () => {
  it('leaves a right-click on an agent row to the row, opening no workspace menu', () => {
    render(<Card />)
    expect(openFrom('agent-row')).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('treats a control inside the row (keyboard-opened menus target it) as the row', () => {
    render(<Card />)
    expect(openFrom('agent-row-control')).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the full workspace menu, Delete included, from the header and the agents expander', () => {
    render(<Card />)
    expect(openFrom('header')).toBe(false)
    expect(screen.getByTestId('mute-item')).toBeTruthy()
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    openFrom('expander')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
  })

  it('decides on every right-click, in either order', () => {
    render(<Card />)
    openFrom('agent-row')
    expect(screen.queryByRole('menu')).toBeNull()
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    expect(openFrom('agent-row')).toBe(true)
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })

  it('leaves agent rows to themselves in a multi-selection too', () => {
    render(<Card isMultiContext />)
    openFrom('header')
    expect(screen.getByTestId('delete-items')).toBeTruthy()
    close()
    expect(openFrom('agent-row')).toBe(true)
    expect(screen.queryByTestId('delete-items')).toBeNull()
  })
})
