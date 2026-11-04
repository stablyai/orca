// @vitest-environment happy-dom
import { createRef, Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as ProjectionSelector from '@/store/project-host-setup-selector'
import type * as SessionProjection from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeGroup, makeUnifiedTab } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import { emptyNativeChatContextMenuActions } from './use-native-chat-context-menu'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

vi.mock('./native-chat-layout-actions', () => ({ runNativeChatSplitTarget: vi.fn(() => true) }))
vi.mock('./NativeChatSelectionQuote', () => ({ NativeChatSelectionQuote: () => null }))
// Call-through counters: render counts alone miss pane-key hashing and projection reads.
const work = vi.hoisted(() => ({ paneKeys: 0, projections: 0, commits: 0 }))
vi.mock(
  '../../../../shared/agent-session/view/structured-agent-session-projection',
  async (importOriginal) => {
    const actual = await importOriginal<typeof SessionProjection>()
    return {
      ...actual,
      structuredAgentSessionPaneKey: (tabId: string, sessionId: string) => (
        work.paneKeys++,
        actual.structuredAgentSessionPaneKey(tabId, sessionId)
      )
    }
  }
)
vi.mock('@/store/project-host-setup-selector', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectionSelector>()
  return {
    ...actual,
    getProjectHostSetupProjectionFromState: (
      state: Parameters<typeof actual.getProjectHostSetupProjectionFromState>[0]
    ) => (work.projections++, actual.getProjectHostSetupProjectionFromState(state))
  }
})
const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const initial = useAppStore.getState()
const upsertTerminalQuickCommand = vi.fn(async () => true)
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
    pane: {
      tabId: `chat-${index}`,
      groupId: 'group-owner',
      isVisible: index % 3 !== 1,
      isFocusedGroup: true,
      agent: 'codex',
      contextMenuActions: index % 3 === 2 ? emptyNativeChatContextMenuActions : undefined,
      sessionId: SESSION,
      target: { kind: 'local' }
    },
    handOff: { available: false, preparing: false, open: () => {}, reset: () => {}, dialog: null },
    sessionContext: { messages: [], epoch: null },
    ownerWorktreeId: 'owner',
    rootRef,
    composerRef: createRef(),
    questionAnswerInputRef: createRef()
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
function writeProviderId(paneKey: string, id: string) {
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: [],
    providerSession: { key: 'session_id', id }
  }
  useAppStore.setState((state) => ({
    agentStatusByPaneKey: { ...state.agentStatusByPaneKey, [paneKey]: entry }
  }))
}
// Menu-only data: repos, project/setup catalogs and agent status for other panes.
const catalogWrites = [
  () => useAppStore.setState((state) => ({ repos: [...state.repos] })),
  () =>
    useAppStore.setState((state) => ({
      projects: [...state.projects],
      projectHostSetups: [...state.projectHostSetups]
    })),
  ...Array.from(
    { length: 10 },
    (_, index) => () => writeProviderId(`unrelated-${index}`, `provider-${++revision}`)
  )
]
function measureWork(write: () => void) {
  const before = renders
  Object.assign(work, { paneKeys: 0, projections: 0, commits: 0 })
  act(write)
  return { ...work, renders: renders - before }
}
const noWork = { paneKeys: 0, projections: 0, commits: 0, renders: 0 }

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
      repos: [
        { id: 'owner', path: '/repo/owner', displayName: 'Owner', badgeColor: '', addedAt: 0 }
      ],
      settings: { ...getDefaultSettings('/tmp'), terminalQuickCommands: [] },
      upsertTerminalQuickCommand,
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
    expect(catalogWrites.map(measureWork)).toEqual(catalogWrites.map(() => noWork))
  }
  const hosts = Array.from({ length: size }, (_, index) => <Host key={index} index={index} />)
  render(
    <Profiler id="chats" onRender={() => work.commits++}>
      {hosts}
    </Profiler>,
    { wrapper: TooltipProvider }
  )
  idle()
  fireEvent.contextMenu(screen.getByTestId('host-0'))
  await screen.findByRole('menu')
  expect(screen.queryByRole('menuitem', { name: 'Copy Session ID' })).toBeNull()
  // The open menu reads its own chat's provider ID; other chats' IDs reach nothing.
  const ownKey = structuredAgentSessionPaneKey('chat-0', SESSION)
  const otherKey = structuredAgentSessionPaneKey('chat-3', SESSION)
  act(() => writeProviderId(ownKey, 'provider-own'))
  await screen.findByRole('menuitem', { name: 'Copy Session ID' })
  // Only the one open menu's cached projection read runs, whatever the chat count.
  expect(measureWork(() => writeProviderId(otherKey, 'provider-other'))).toEqual({
    ...noWork,
    projections: 1
  })
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Quick Commands',
    expect.stringContaining('Split Chat Right'),
    expect.stringContaining('Split Chat Down'),
    'Copy Session ID',
    'Copy Orca Session ID',
    expect.stringContaining('Close tab')
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
  // Add closes the menu first; the editor outlives it and saves to the chosen host.
  fireEvent.contextMenu(screen.getByTestId('host-0'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Quick Commands' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Quick Command…' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  fireEvent.change(await screen.findByPlaceholderText('Start dev server'), {
    target: { value: 'Lint' }
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
    target: { value: 'pnpm lint' }
  })
  fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(upsertTerminalQuickCommand).toHaveBeenCalledWith(
    'local',
    expect.objectContaining({
      label: 'Lint',
      command: 'pnpm lint',
      scope: { type: 'repo', repoId: 'owner' }
    })
  )
  idle()
})
