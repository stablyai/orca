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
import { readBots } from '../../lib/bot-catalog'
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
  return Array.from({ length: count }, (_, index) => ({
    id: index === count - 1 ? 'home' : `tab-${index}`,
    entityId: index === count - 1 ? 'home-chat' : `chat-${index}`,
    contentType: 'agent-session',
    executionHostId: 'local',
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
  'skips Home discovery for %i mounted ordinary tabs and an order replacement',
  (count) => {
    const finder = vi.spyOn(homes, 'findPinnedHomeTabId')
    const rows = tabs(count, ORDINARY)
    const view = render(strip(rows, ORDINARY))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    view.rerender(strip([...rows], ORDINARY, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
  }
)

it.each([750, 7500])(
  'skips Home discovery in an enabled empty-catalog folder with %i projected tabs',
  (count) => {
    expect(useAppStore.getState().settings!.botsEnabled).toBe(true)
    expect(readBots()).toHaveLength(0)
    const finder = vi.spyOn(homes, 'findPinnedHomeTabId')
    const rows = tabs(count, FOLDER)
    expect(rows).toHaveLength(count)
    const view = render(strip(rows, FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    expect(view.container.querySelector('[data-pinned-home-slot]')).toBeNull()
    view.rerender(strip([...rows], FOLDER, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
  }
)

it.each([750, 7500])(
  'admits live Home publication among %i tabs while skipping empty and disabled catalogs',
  (count) => {
    const finder = vi.spyOn(homes, 'findPinnedHomeTabId')
    const rows = tabs(count, FOLDER)
    expect(rows).toHaveLength(count)
    const view = render(strip(rows, FOLDER))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    const homeIsPinned = () => {
      expect(finder.mock.calls.some(([items]) => items.length === count)).toBe(true)
      expect(
        finder.mock.results.some((result) => result.type === 'return' && result.value === 'home')
      ).toBe(true)
      const slot = view.container.querySelector('[data-pinned-home-slot]')
      if (!slot) {
        throw new Error('The live Home publication did not create a pinned slot')
      }
      expect(slot.querySelector('[data-tab-strip-slot="home"]')).not.toBeNull()
      const first = view.container.querySelector('[data-tab-strip-slot]')
      if (!first) {
        throw new Error('The tab strip did not render a slot')
      }
      expect(first.getAttribute('data-tab-strip-slot')).toBe('home')
      const scroller = view.container.querySelector('[data-tab-strip-scroller]')
      if (!scroller) {
        throw new Error('The tab strip did not render its scroller')
      }
      expect(scroller.querySelector('[data-tab-strip-slot="home"]')).toBeNull()
    }
    const publications = [readBots().length]
    act(() => stubBots([bot]))
    homeIsPinned()
    publications.push(readBots().length)
    finder.mockClear()
    act(() => stubBots([]))
    publications.push(readBots().length)
    expect(readBots()).toHaveLength(0)
    expect.soft(finder).toHaveBeenCalledTimes(0)
    expect(view.container.querySelector('[data-pinned-home-slot]')).toBeNull()
    view.rerender(strip([...rows], FOLDER, true))
    expect.soft(finder).toHaveBeenCalledTimes(0)
    finder.mockClear()
    act(() => stubBots([bot]))
    homeIsPinned()
    publications.push(readBots().length)
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
    expect(publications).toEqual([0, 1, 0, 1])
    console.info('STA18089 live publication completed', {
      projectedCount: rows.length,
      catalogLengths: publications
    })
  }
)
