// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useTerminalPaneTitleEffects } from './use-terminal-pane-title-effects'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'
const TAB = 'viewed-tab'
const PANE = makePaneKey(TAB, LEAF)
const SIBLING_PANE = makePaneKey(TAB, SIBLING)
const originalState = useAppStore.getState()

afterEach(() => useAppStore.setState(originalState, true))

it.each([false, true])('click clears its pane and preserves sibling attention=%s', (hasSibling) => {
  const workspace = makeFolderWorkspace({ id: 'pointer-folder', isUnread: true })
  const workspaceId = folderWorkspaceKey(workspace.id)
  useAppStore.setState({
    folderWorkspaces: [workspace],
    tabsByWorktree: { [workspaceId]: [makeTab({ id: TAB, worktreeId: workspaceId })] },
    unreadTerminalTabs: { [TAB]: 'terminal-bell' },
    unreadTerminalPanes: hasSibling
      ? { [PANE]: 'terminal-bell', [SIBLING_PANE]: 'terminal-bell' }
      : { [PANE]: 'terminal-bell' },
    updateFolderWorkspace: vi.fn().mockResolvedValue(true)
  })
  const container = document.createElement('div')
  const pane = document.createElement('div')
  pane.className = 'pane'
  pane.dataset.leafId = LEAF
  container.appendChild(pane)
  const host = document.createElement('div')
  const root = createRoot(host)
  const controller = {
    ...useAppStore.getState(),
    tabId: TAB,
    worktreeId: workspaceId,
    containerRef: { current: container },
    managerRef: { current: null },
    setPaneTitleOverlayRects: vi.fn(),
    setSessionRestoredBannerPaneIds: vi.fn(),
    renameInputRef: createRef<HTMLInputElement>(),
    renamingPaneId: null
  }
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Null manager and rename state skip pane lifecycle effects; the fixture supplies every field read by the pointer effect.
    useTerminalPaneTitleEffects(controller as unknown as TerminalPaneCloseController)
    return null
  }
  try {
    act(() => root.render(<Probe />))
    act(() => pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))

    expect(useAppStore.getState().unreadTerminalPanes[PANE]).toBeUndefined()
    expect(useAppStore.getState().unreadTerminalTabs[TAB]).toBeUndefined()
    expect(useAppStore.getState().folderWorkspaces[0].isUnread).toBe(hasSibling)
    expect(useAppStore.getState().unreadTerminalPanes[SIBLING_PANE]).toBe(
      hasSibling ? 'terminal-bell' : undefined
    )
  } finally {
    act(() => root.unmount())
  }
})
