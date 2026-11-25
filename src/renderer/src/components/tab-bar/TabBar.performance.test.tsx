// @vitest-environment happy-dom
// Perf contract (STA-18089/#48561): a known-empty bot catalog must not scan a mounted strip for Home.
import { act, cleanup, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { Bot } from '../../../../shared/bot-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { I18nProvider } from '../../i18n/I18nProvider'
import { TooltipProvider } from '../ui/tooltip'
import { installWebPreloadApi } from '../../web/web-preload-api'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { useAppStore } from '../../store'
import * as homes from './model/pinned-home-tab'
import TabBar from './TabBar'

const GROUP = 'perf-group'
const ORDINARY = 'ordinary-worktree'
const FOLDER = 'folder:perf-bot-folder'
const noop = (): void => {}
const bot: Bot = {
  id: 'perf-bot',
  name: 'Fixture bot',
  hostId: 'local',
  folder: 'perf-bot',
  folderWorkspaceId: 'perf-bot-folder',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'home-chat',
  createdAt: 0,
  updatedAt: 0
}
const initialStore = useAppStore.getState()

function tabs(count: number, workspace: string): (Tab & { contentType: 'agent-session' })[] {
  // The first chat has Home's id on another host; only the last chat can own this page's Home.
  return Array.from({ length: count }, (_, index) => ({
    id: index === count - 1 ? 'home' : `tab-${index}`,
    entityId: index === 0 || index === count - 1 ? 'home-chat' : `chat-${index}`,
    contentType: 'agent-session',
    executionHostId: index === 0 ? 'runtime:other' : 'local',
    groupId: GROUP,
    worktreeId: workspace,
    agentSessionAgent: 'codex',
    label: `Fixture ${index}`,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    isPinned: index === count - 1
  }))
}

function strip(rows: ReturnType<typeof tabs>, workspace: string, reverse = false) {
  const order = rows.map((row) => row.id)
  if (reverse) {
    order.reverse()
  }
  return (
    <I18nProvider>
      <TooltipProvider>
        <DndContext>
          <TabBar
            tabs={[]}
            agentSessionTabs={rows}
            tabBarOrder={order}
            activeTabId="home"
            activeTabType="agent-session"
            worktreeId={workspace}
            groupId={GROUP}
            expandedPaneByTabId={{}}
            showAgentLaunchItems={false}
            onActivate={noop}
            onActivateAgentSession={noop}
            onClose={noop}
            onCloseOthers={noop}
            onCloseToRight={noop}
            onCloseToLeft={noop}
            onNewTerminalTab={noop}
            onNewBrowserTab={noop}
            onSetCustomTitle={noop}
            onSetTabColor={noop}
            onTogglePaneExpand={noop}
          />
        </DndContext>
      </TooltipProvider>
    </I18nProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  installWebPreloadApi()
  Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
  useAppStore.setState(initialStore, true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en', botsEnabled: true }
  })
  stubBots([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([750, 7500])(
  'skips discovery across empty catalog transitions with %i projected tabs and preserves host-scoped Home',
  (count) => {
    const finder = vi.spyOn(homes, 'findPinnedHomeTabId')
    const rows = tabs(count, FOLDER)
    const view = render(strip(rows, FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    view.rerender(strip([...rows], FOLDER, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    view.rerender(strip([...rows], FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)

    const homeIsPinned = () => {
      expect(finder.mock.calls.some(([items]) => items.length === count)).toBe(true)
      expect(
        finder.mock.results.some((result) => result.type === 'return' && result.value === 'home')
      ).toBe(true)
      const slot = view.container.querySelector('[data-pinned-home-slot]')
      const first = view.container.querySelector('[data-tab-strip-slot]')
      const scroller = view.container.querySelector('[data-tab-strip-scroller]')
      if (!slot || !first || !scroller) {
        throw new Error('Home publication must render both the pinned slot and the scrolling strip')
      }
      expect(slot.querySelector('[data-tab-strip-slot="home"]')).not.toBeNull()
      expect(first.getAttribute('data-tab-strip-slot')).toBe('home')
      expect(scroller.querySelector('[data-tab-strip-slot="home"]')).toBeNull()
    }

    act(() => stubBots([bot]))
    homeIsPinned()
    finder.mockClear()
    act(() => stubBots([]))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    expect(view.container.querySelector('[data-pinned-home-slot]')).toBeNull()
    view.rerender(strip([...rows], FOLDER, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    view.rerender(strip([...rows], FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)

    finder.mockClear()
    act(() => stubBots([bot]))
    homeIsPinned()
    finder.mockClear()
    act(() =>
      useAppStore.setState((state) => ({ settings: { ...state.settings!, botsEnabled: false } }))
    )
    view.rerender(strip([...rows], FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    expect(view.container.querySelector('[data-pinned-home-slot]')).toBeNull()
    act(() =>
      useAppStore.setState((state) => ({ settings: { ...state.settings!, botsEnabled: true } }))
    )
    homeIsPinned()
    finder.mockClear()
    view.rerender(strip(tabs(count, ORDINARY), ORDINARY))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    view.rerender(strip(tabs(count, ORDINARY), ORDINARY, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
  }
)
