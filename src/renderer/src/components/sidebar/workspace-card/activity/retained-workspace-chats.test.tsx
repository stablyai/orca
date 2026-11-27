// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  workspaceChatCatalog,
  type WorkspaceChat
} from '@/lib/agent-session/history/workspace-chats'
import { RetainedWorkspaceChats } from './retained-workspace-chats'
import { WorkspaceChatList } from './workspace-chat-list'

const effects = vi.hoisted(() => ({
  waitForRetirement: vi.fn(),
  activate: vi.fn(),
  open: vi.fn(),
  showError: vi.fn(),
  state: { activeWorktreeId: 'workspace-a', unifiedTabsByWorktree: {} }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: typeof effects.state) => unknown) => select(effects.state),
    {
      getState: () => effects.state
    }
  )
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: effects.activate
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  openDesktopStructuredSession: effects.open
}))
vi.mock(
  '@/runtime/native-chat/tab-retirement/structured-agent-session-host-tab-retirement',
  () => ({
    waitForStructuredAgentSessionTabRetirement: effects.waitForRetirement
  })
)
vi.mock('@/runtime/native-chat/session-ownership/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: () => 'local',
  structuredAgentSessionOwnerForTab: () => 'local',
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('sonner', () => ({ toast: { error: effects.showError } }))

const first: WorkspaceChat = {
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  executionHostId: 'local',
  agent: 'codex',
  title: 'Earlier chat'
}
const second: WorkspaceChat = {
  ...first,
  workspaceId: 'workspace-b',
  sessionId: 'session-b',
  title: 'Later chat'
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  effects.state.activeWorktreeId = first.workspaceId
  effects.waitForRetirement.mockResolvedValue(true)
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  const catalog = workspaceChatCatalog()
  for (const chat of catalog.getSnapshot()) {
    catalog.archive(chat)
  }
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

function renderSavedChats() {
  const catalog = workspaceChatCatalog()
  catalog.remember(first)
  catalog.remember(second)
  act(() => {
    root.render(
      <TooltipProvider>
        <RetainedWorkspaceChats worktreeId={first.workspaceId} executionHostId="local" />
        <RetainedWorkspaceChats worktreeId={second.workspaceId} executionHostId="local" />
      </TooltipProvider>
    )
  })
}

function chatButton(chat: WorkspaceChat): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[title="${chat.title}"]`)!
}

it('keeps the later workspace selected when the earlier chat finishes retiring', async () => {
  const retiring = Promise.withResolvers<boolean>()
  effects.waitForRetirement.mockReturnValueOnce(retiring.promise)
  renderSavedChats()

  act(() => chatButton(first).click())
  await act(async () => chatButton(second).click())
  await act(async () => retiring.resolve(true))

  expect(effects.activate.mock.calls.map(([workspace]) => workspace)).toEqual([second.workspaceId])
  expect(effects.open).toHaveBeenCalledTimes(1)
})

it('reports a failed host tab close and leaves the saved chat available to retry', async () => {
  effects.waitForRetirement.mockResolvedValueOnce(false)
  renderSavedChats()

  await act(async () => chatButton(first).click())

  expect(effects.open).not.toHaveBeenCalled()
  expect(effects.showError).toHaveBeenCalledWith('Could not reopen this chat. Try again.')
  expect(chatButton(first).disabled).toBe(false)
})

it('reports a rejected open callback and re-enables the row', async () => {
  act(() => {
    root.render(
      <TooltipProvider>
        <WorkspaceChatList
          chats={[first]}
          onOpen={() => Promise.reject(new Error('Host disconnected'))}
          onArchive={() => {}}
        />
      </TooltipProvider>
    )
  })

  await act(async () => chatButton(first).click())

  expect(effects.showError).toHaveBeenCalledWith('Could not reopen this chat. Try again.')
  expect(chatButton(first).disabled).toBe(false)
})
