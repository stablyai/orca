// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeGroup, makeUnifiedTab } from '../worktree-jump-palette-test-fixtures'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import { emptyNativeChatContextMenuActions } from './use-native-chat-context-menu'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'

vi.mock('./native-chat-layout-actions', () => ({ runNativeChatSplitTarget: vi.fn(() => true) }))
vi.mock('./NativeChatSelectionQuote', () => ({ NativeChatSelectionQuote: () => null }))
const initial = useAppStore.getState()
let reads = 0
let renders = 0
let revision = 0
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})
function Host({ index }: { index: number }) {
  renders++
  const rootRef = createRef<HTMLDivElement>()
  const { menu, ...commands } = useStructuredNativeChatPaneCommands({
    tabId: `chat-${index}`,
    groupId: 'group-owner',
    ownerWorktreeId: 'owner',
    isVisible: index % 3 !== 1,
    terminalPaneActions: index % 3 === 2 ? emptyNativeChatContextMenuActions : undefined,
    rootRef,
    composerRef: createRef(),
    questionAnswerInputRef: createRef(),
    sessionId: '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37',
    target: { kind: 'local' }
  })
  return (
    <div ref={rootRef} data-testid={`host-${index}`} {...commands}>
      {menu}
    </div>
  )
}
function measure(write: () => void) {
  for (const tab of Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()) {
    for (const key of ['id', 'groupId'] as const) {
      const value = tab[key]
      Object.defineProperty(tab, key, {
        configurable: true,
        enumerable: true,
        get: () => (reads++, value)
      })
    }
  }
  reads = 0
  act(write)
  return reads
}

it.each([6, 60])('bounds retained menu work at %i chats', async (size) => {
  const seed = () => {
    const tabs = Array.from({ length: size }, (_, index) => ({
      ...makeUnifiedTab(`chat-${index}`, 'owner', `session-${index}`, 'Chat'),
      contentType: 'agent-session' as const,
      agentSessionAgent: 'codex' as const
    }))
    const ids = tabs.map((tab) => tab.id)
    const other = { ...tabs[0], id: 'other', worktreeId: 'other', groupId: 'group-other' }
    useAppStore.setState({
      keybindings: initial.keybindings,
      tabsByWorktree: {},
      unifiedTabsByWorktree: { owner: tabs, other: [other] },
      groupsByWorktree: {
        owner: [makeGroup('owner', ids)],
        other: [makeGroup('other', ['other'])]
      }
    })
  }
  const writes = [
    () => useAppStore.getState().setTabLabel('chat-1', `Title ${++revision}`),
    () => useAppStore.getState().activateTab('chat-1'),
    () => useAppStore.getState().setTabLabel('other', `Other ${++revision}`),
    () => useAppStore.getState().activateTab('other'),
    () => useAppStore.setState({ activeWorktreeId: 'unrelated' })
  ]
  seed()
  const baseline = writes.map(measure)
  const idle = () => {
    act(seed)
    const before = renders
    expect(writes.map(measure)).toEqual(baseline)
    expect(renders).toBe(before)
  }
  const hosts = Array.from({ length: size }, (_, index) => <Host key={index} index={index} />)
  render(hosts, { wrapper: TooltipProvider })
  idle()
  fireEvent.contextMenu(screen.getByTestId('host-0'))
  await screen.findByRole('menu')
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    expect.stringContaining('Split Chat Right'),
    expect.stringContaining('Split Chat Down'),
    'Copy Orca Session ID'
  ])
  const opened = renders
  const extra = measure(writes[0]) - baseline[0]
  expect(extra).toBeGreaterThanOrEqual(size - 1)
  expect(extra).toBeLessThanOrEqual(size * 2)
  expect(renders).toBe(opened)
  await new Promise((resolve) => setTimeout(resolve, 110))
  fireEvent.click(screen.getByRole('menuitem', { name: /Split Chat Right/ }))
  expect(runNativeChatSplitTarget).toHaveBeenLastCalledWith(
    { kind: 'workspace-tab', unifiedTabId: 'chat-0', groupId: 'group-owner' },
    'right'
  )
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  idle()
})
