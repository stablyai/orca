// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'

import type { Tab } from '../../../../shared/tab-types'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { makeTabGroup } from '@/store/slices/store-test-helpers'
import {
  makeFolderWorkspace,
  makeUnifiedTab
} from '../worktree-jump/worktree-jump-palette-test-fixtures'

import * as history from '../right-sidebar/ai-vault/scanning/ai-vault-panel-session-list-request'
import type { NativeChatCliForkPreparation } from '@/lib/agent-session/resume/cli-fork/native-chat-cli-fork-preparation'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), launch: vi.fn(), close: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('./NativeChatView', async () => {
  const { nativeChatPaneHeader } = await import('./NativeChatPaneHeader')
  return {
    default: (props: NativeChatStructuredViewProps) => (
      <div className="native-chat-appearance" data-chat={props.tabId}>
        {nativeChatPaneHeader(props, 'folder:workspace', 'dark')}
        <output data-transcript={props.tabId}>{props.sessionId}</output>
      </div>
    )
  }
})
vi.mock('@/lib/workspace/tabs/workspace-tab-commands', () => ({
  dispatchWorkspaceTabCommand: mocks.close
}))
vi.mock('@/lib/agent-session/resume/cli-fork/native-chat-cli-fork-preparation', () => ({
  prepareNativeChatCliFork: mocks.prepare
}))
vi.mock('@/lib/launch-ai-vault-session-and-reveal', () => ({
  launchAiVaultSessionAndReveal: mocks.launch
}))
vi.mock('@/lib/agent-session/resume/history/ai-vault-session-fork-startup', () => ({
  assertAiVaultCopiedSessionLaunchAllowed: () => {},
  buildAiVaultForkStartupForWorktree: () => ({ command: 'fixture-fork' })
}))

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'

const workspace = 'folder:workspace'
const initial = useAppStore.getInitialState()
const fullRequest = vi.spyOn(history, 'resolveAiVaultPanelSessionListRequest')

const testWindow = window
const originalApi = window.api
const api = createTabsSliceMockApi()
vi.stubGlobal('window', testWindow)
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api })
  useAppStore.setState(initial, true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'workspace', folderPath: '/repo' })]
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  Object.assign(window, { api: originalApi })
})
function seedChats(size: number) {
  const tabs: Tab[] = Array.from({ length: size }, (_, index) => ({
    ...makeUnifiedTab(`chat-${index}`, workspace, `session-${index}`, `Chat ${index}`),
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    executionHostId: 'local',
    groupId: index === size - 1 ? 'second' : 'first'
  }))
  const groups = ['first', 'second'].map((id) =>
    makeTabGroup({
      id,
      worktreeId: workspace,
      tabOrder: tabs.filter((tab) => tab.groupId === id).map((tab) => tab.id),
      activeTabId: id === 'first' ? 'chat-0' : `chat-${size - 1}`
    })
  )
  useAppStore.setState({
    unifiedTabsByWorktree: { [workspace]: tabs },
    groupsByWorktree: { [workspace]: groups },
    activeGroupIdByWorktree: { [workspace]: 'first' }
  })
}
function overlay(active: boolean) {
  return (
    <TooltipProvider>
      <StructuredAgentSessionPaneOverlayLayer worktreeId={workspace} isWorktreeActive={active} />
    </TooltipProvider>
  )
}
function chat(container: HTMLElement, id: string) {
  return within(container).getByText(`session-${id.slice(5)}`).parentElement!
}

it('keeps the real Continue pending operation disabled across header hide/reveal and launches once', async () => {
  seedChats(10)
  const preparation = Promise.withResolvers<NativeChatCliForkPreparation>()
  mocks.prepare.mockReturnValue(preparation.promise)
  mocks.launch.mockResolvedValue(undefined)
  const view = render(overlay(true))
  const source = chat(view.container, 'chat-0')
  const button = () => within(source).getByRole('button', { name: 'Continue with Terminal Agent' })
  expect(fullRequest).not.toHaveBeenCalled()
  fireEvent.click(button())
  expect(button().hasAttribute('disabled')).toBe(true)
  expect(button().getAttribute('aria-busy')).toBe('true')
  view.rerender(overlay(false))
  expect(within(source).queryByRole('button')).toBeNull()
  expect(useAppStore.getState().getTab('chat-0')).not.toBeNull()
  view.rerender(overlay(true))
  expect(button().hasAttribute('disabled')).toBe(true)
  expect(button().getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button())
  expect(mocks.prepare).toHaveBeenCalledTimes(1)
  await act(async () =>
    preparation.resolve({
      copied: false,
      session: { agent: 'codex', sessionId: 'fork', cwd: '/repo', codexHome: null }
    })
  )
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  expect(button().hasAttribute('disabled')).toBe(false)
  expect(button().hasAttribute('aria-busy')).toBe(false)
  expect(fullRequest).toHaveBeenCalledTimes(1)
})
