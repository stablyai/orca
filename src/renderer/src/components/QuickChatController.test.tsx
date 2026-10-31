// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewTabAgentMenuModel } from './tab-bar/new-tab-agent-menu-model'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'

const mocks = vi.hoisted(() => {
  const initialModel = (): NewTabAgentMenuModel => ({ state: 'loading', placeholderCount: 2 })
  return {
    start: vi.fn(),
    launch: vi.fn(),
    activate: vi.fn(),
    error: vi.fn(),
    model: initialModel()
  }
})
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      activeGroupIdByWorktree: {},
      repos: []
    })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => {} }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => '⌘⌥N' }))
vi.mock('@/lib/start-quick-chat', () => ({
  startQuickChat: mocks.start,
  showQuickChatFailure: mocks.error
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('./native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus: vi.fn()
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('./tab-bar/use-new-tab-agent-menu-rows', () => ({
  useNewTabAgentMenuRows: () => mocks.model
}))
vi.mock('./agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: () => []
}))
vi.mock('./tab-bar/QuickLaunchButton', () => ({
  useTabAgentMenuLaunch: () => mocks.launch,
  ProjectedAgentMenuItems: ({ runLaunch }: { runLaunch: (row: NewTabAgentMenuRow) => void }) => (
    <button onClick={() => runLaunch({ kind: 'chat', agent: 'codex', executionHostId: 'local' })}>
      Choose Codex
    </button>
  )
}))
import { QuickChatController } from './QuickChatController'
import { QuickChatButton } from './QuickChatButton'
import { TooltipProvider } from './ui/tooltip'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.start.mockResolvedValue('folder-chats')
  mocks.activate.mockReturnValue({ primaryTabId: null })
  mocks.model = {
    state: 'settled',
    rows: [{ kind: 'chat', agent: 'codex', executionHostId: 'local' }],
    defaultTuiAgent: 'codex',
    detection: {
      detectedIds: ['codex'],
      detectionFailed: false,
      needsServerUpdate: false,
      isLoading: false,
      isRefreshing: false,
      refresh: async () => ['codex']
    }
  }
})
function mount() {
  return render(
    <TooltipProvider>
      <QuickChatController />
      <QuickChatButton landing />
    </TooltipProvider>
  )
}
it('opens a chat for each click and activates without seeding a shell', async () => {
  mount()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(mocks.launch).toHaveBeenCalledWith({
    kind: 'chat',
    agent: 'codex',
    executionHostId: 'local'
  })
  expect(mocks.activate).toHaveBeenCalledWith('folder-chats', {
    executionHostId: 'local',
    providesInitialSurface: true
  })
})
it('opens the existing picker instead of launching an agent with no chat row', async () => {
  if (mocks.model.state === 'settled') {
    mocks.model.defaultTuiAgent = 'blank'
  }
  mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New chat' })))
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Choose Codex' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Choose Codex' }))
  expect(mocks.launch).toHaveBeenCalledTimes(1)
})
it('does not launch after activation fails', async () => {
  mocks.activate.mockReturnValue(false)
  mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New chat' })))
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(1)
})
it('waits for the folder fetch and agent rows before launching', async () => {
  let ready: (id: string) => void = () => {}
  mocks.start.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        ready = resolve
      })
  )
  mocks.model = { state: 'loading', placeholderCount: 2 }
  const view = mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New chat' })))
  expect(mocks.launch).not.toHaveBeenCalled()
  await act(async () => ready('folder-chats'))
  expect(mocks.launch).not.toHaveBeenCalled()
  mocks.model = {
    state: 'settled',
    rows: [],
    detection: {
      detectedIds: [],
      detectionFailed: false,
      needsServerUpdate: false,
      isLoading: false,
      isRefreshing: false,
      refresh: async () => []
    }
  }
  view.rerender(
    <TooltipProvider>
      <QuickChatController />
    </TooltipProvider>
  )
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Choose Codex' })).toBeTruthy()
})
