import { expect, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import TabGroupPanel from '../tab-group/TabGroupPanel'
import { registerTabGroupBody } from '../tab-group/tab-group-body-geometry'
import { dispatchTerminalShortcutAction } from '../terminal-pane/terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from '../terminal-pane/terminal-shortcut-policy'
import type { TerminalCrewPortals } from './TerminalCrewPortals'
import { ConfirmationDialogProvider } from '../confirmation-dialog'

export function retainedCrewSurfaces(
  root: HTMLElement,
  kind: 'terminal' | 'editor' | 'agent-session'
) {
  const otherRoot = document.createElement('div')
  const otherManager = new PaneManager(otherRoot, { linkOpenHint: () => '' })
  const otherPane = otherManager.createInitialPane({ focus: false })
  const otherInput = document.createElement('textarea')
  otherInput.setAttribute('aria-label', 'Other retained input')
  otherPane.container.append(otherInput)
  vi.spyOn(otherPane.terminal, 'focus').mockImplementation(() => otherInput.focus())
  const unregister = ['source', 'other'].map((id) => {
    const anchor = document.createElement('div')
    document.body.append(anchor)
    const remove = registerTabGroupBody(id, anchor)
    return () => {
      remove()
      anchor.remove()
    }
  })
  const tabs = [
    { id: 'source-tab', entityId: 'tab', groupId: 'source', contentType: 'terminal' as const },
    { id: 'other-tab', entityId: 'other-content', groupId: 'other', contentType: kind }
  ].map((tab) => ({
    ...tab,
    worktreeId: 'workspace',
    label: tab.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }))
  useAppStore.setState({
    activeWorktreeId: 'workspace',
    activeGroupIdByWorktree: { workspace: 'source' },
    groupsByWorktree: {
      workspace: tabs.map((tab) => ({
        id: tab.groupId,
        worktreeId: 'workspace',
        activeTabId: tab.id,
        tabOrder: [tab.id]
      }))
    },
    unifiedTabsByWorktree: { workspace: tabs },
    terminalLayoutsByTabId: {}
  })
  const focus = (groupId: string) => useAppStore.getState().focusGroup('workspace', groupId)
  return {
    otherManager,
    otherPane,
    otherInput,
    dispose: () => {
      otherManager.destroy()
      unregister.forEach((remove) => remove())
    },
    wrap: (children: ReactNode) => (
      <ConfirmationDialogProvider>
        <RetainedPaneHost groupId="source" isVisible onFocusOwningGroup={focus}>
          <div
            ref={(node) => {
              node?.append(root)
            }}
          />
          {children}
        </RetainedPaneHost>
        {kind === 'editor' ? (
          <TabGroupPanel
            groupId="other"
            worktreeId="workspace"
            isVisible
            isFocused={false}
            hasSplitGroups
            touchesLeftEdge={false}
            touchesRightEdge={false}
            tabStrip="external"
            reserveClosedExplorerToggleSpace={false}
            reserveCollapsedSidebarHeaderSpace={false}
          />
        ) : (
          <RetainedPaneHost groupId="other" isVisible onFocusOwningGroup={focus}>
            <div
              ref={(node) => {
                node?.append(otherRoot)
              }}
            />
          </RetainedPaneHost>
        )}
      </ConfirmationDialogProvider>
    )
  }
}

export function selectConfiguredNextPane(
  controller: ComponentProps<typeof TerminalCrewPortals>['controller'],
  manager: PaneManager
) {
  const event = new KeyboardEvent('keydown', {
    key: 'F8',
    code: 'F8',
    ctrlKey: true,
    cancelable: true
  })
  const action = resolveTerminalShortcutAction(event, false, 'false', 0, false, {
    'terminal.focusNextPane': ['Ctrl+F8']
  })
  expect(action).toEqual({ type: 'focusPane', direction: 'next' })
  if (!action) {
    throw new Error('configured focusPane action not resolved')
  }
  dispatchTerminalShortcutAction(action, event, manager, {
    tabId: controller.tabId,
    worktreeId: controller.worktreeId,
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: false },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: controller.paneTransportsRef,
    paneCwdRef: { current: new Map() },
    managerRef: controller.managerRef,
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: vi.fn()
  })
  expect(event.defaultPrevented).toBe(true)
}
