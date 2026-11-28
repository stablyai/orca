// @vitest-environment happy-dom
// While another person's tabs cover this window's own, the window's own tabs change only by what its
// person does to them: a tab of its own shown by their act leaves the view; a background update, a
// visit, or a close or move shortcut pressed over the view touches neither.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { recordShownTabFocus } from '@/lib/workspace/activation/worktree-activation-visit'
import { handleTerminalWorkspaceKeyDown } from '@/components/terminal/keyboard-shortcuts/terminal-workspace-keydown'
import type { TerminalActivationController } from '@/components/terminal/tab-lifecycle/use-terminal-activation-actions'
import { useViewedTabList, viewTabList } from './viewed-tab-list'
import { renderHook } from '@testing-library/react'

const HOME = folderWorkspaceKey('home-1')
const MATES = { person: { accountId: 'acc-mate' }, picked: null }

function ownTab(id: string, contentType: Tab['contentType'], sortOrder: number): Tab {
  return {
    id,
    entityId: id,
    contentType,
    worktreeId: HOME,
    groupId: 'group',
    executionHostId: 'local',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function viewed(): unknown {
  return renderHook(() => useViewedTabList(HOME)).result.current
}

beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: HOME,
    activeView: 'terminal',
    unifiedTabsByWorktree: {
      [HOME]: [
        ownTab('own-chat', 'agent-session', 0),
        ownTab('own-chat-2', 'agent-session', 1),
        ownTab('own-terminal', 'terminal', 2)
      ]
    },
    groupsByWorktree: {
      [HOME]: [
        {
          id: 'group',
          worktreeId: HOME,
          activeTabId: 'own-chat',
          tabOrder: ['own-chat', 'own-chat-2', 'own-terminal']
        }
      ]
    },
    activeGroupIdByWorktree: { [HOME]: 'group' }
  })
  viewTabList(HOME, MATES.person)
})
afterEach(() => {
  viewTabList(HOME, null)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('leaves the view when one of its own tabs of any kind is made the one shown', () => {
  useAppStore.getState().activateTab('own-chat-2', { worktreeId: HOME, recordFocus: false })
  expect(viewed()).toEqual(MATES)
  recordShownTabFocus(useAppStore.getState(), HOME)
  expect(viewed()).toEqual(MATES)
  useAppStore.getState().activateTab('own-terminal', { worktreeId: HOME })
  expect(viewed()).toBeNull()
})

it('leaves the view for a tab of its own opened in front, and not for one opened behind', () => {
  useAppStore.getState().createUnifiedTab(HOME, 'editor', { entityId: 'behind', activate: false })
  expect(viewed()).toEqual(MATES)
  useAppStore.getState().createUnifiedTab(HOME, 'editor', { entityId: 'in-front' })
  expect(viewed()).toBeNull()
})

it('closes and moves none of its own tabs from a shortcut pressed over the view', () => {
  const ownTabs = () => {
    const state = useAppStore.getState()
    return JSON.stringify([state.unifiedTabsByWorktree[HOME], state.groupsByWorktree[HOME]])
  }
  const showOwn = (activeTabId: string) =>
    useAppStore.setState((state) => ({
      groupsByWorktree: {
        [HOME]: state.groupsByWorktree[HOME]!.map((group) => ({ ...group, activeTabId }))
      }
    }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these shortcuts read only these fields of the workspace's controller.
  const controller = {
    activeWorktreeId: HOME,
    handleCloseAllFiles: vi.fn(),
    // Moving a tab has no default key; this person bound one.
    keybindings: { 'tab.moveRight': ['Mod+Shift+ArrowRight'] },
    terminalShortcutPolicy: 'orca-first'
  } as unknown as TerminalActivationController
  const press = (key: KeyboardEventInit) =>
    handleTerminalWorkspaceKeyDown(
      new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }),
      controller,
      'darwin'
    )
  // Its own terminal is the tab under the view: close it, then all its files.
  showOwn('own-terminal')
  const beforeClose = ownTabs()
  press({ key: 'w', metaKey: true })
  press({ key: 'w', metaKey: true, altKey: true })
  expect(ownTabs()).toBe(beforeClose)
  expect(controller.handleCloseAllFiles).not.toHaveBeenCalled()
  // Its own chat is: move it right.
  showOwn('own-chat')
  const beforeMove = ownTabs()
  press({ key: 'ArrowRight', metaKey: true, shiftKey: true })
  expect(ownTabs()).toBe(beforeMove)
  expect(viewed()).toEqual(MATES)
})
