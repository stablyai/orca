// @vitest-environment happy-dom
import React, { useRef } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotSidebarSearchHost } from './BotSidebarSearch'
import { useBotSidebarSearch } from './use-bot-sidebar-search'
import { useBotCollapseAll } from './use-bot-collapse-all'
import type { BotSearchEntry } from './BotSearchResultRow'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'

const mocks = vi.hoisted(() => ({ openGroup: vi.fn(), onOpenBot: vi.fn(), error: vi.fn() }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { createUiPreferenceActions } =
    await import('@/store/slices/ui/ui-slice-preference-actions')
  return {
    useAppStore: create((set, get) => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only fold actions run; this store supplies their complete state.
      ...createUiPreferenceActions(set as never, get as never),
      botSidebarView: { hidePausedBots: false }
    }))
  }
})
vi.mock('@/lib/bot-group-catalog', () => ({ openBotGroup: () => mocks.openGroup() }))
vi.mock('./BotRow', () => ({ openBotFromSidebar: vi.fn() }))
vi.mock('./BotSearchResultRow', () => ({ BotSearchResultRow: () => <div>Group result</div> }))
vi.mock('./bot-purpose-cache', () => ({
  useBotPurposeReader: () => () => null,
  getBotPurpose: () => null
}))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({ toast: { error: (message: string) => mocks.error(message) } }))

const botEntry: Extract<BotSearchEntry, { kind: 'bot' }> = {
  kind: 'bot',
  id: 'session-bot',
  home: makeFolderWorkspace({ id: 'session-home' }),
  bot: {
    id: 'session-bot',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'session-home',
    agent: 'codex',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}
const groupEntry: Extract<BotSearchEntry, { kind: 'group' }> = {
  kind: 'group',
  id: 'session-group',
  home: makeFolderWorkspace({ id: 'group-home' }),
  group: {
    id: 'session-group',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'crew',
    folderWorkspaceId: 'group-home',
    createdAt: 1,
    members: [],
    replyMode: { kind: 'mentions' }
  }
}
const botAndGroup = [botEntry, groupEntry]
const groupOnly = [groupEntry]
function Session({ entries = botAndGroup }: { entries?: BotSearchEntry[] }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const search = useBotSidebarSearch({ listRef, savedEntries: entries, onOpenBot: mocks.onOpenBot })
  return (
    <>
      <button onClick={search.toggleOpen}>Toggle search</button>
      <BotSidebarSearchHost
        open={search.open}
        regionRef={search.regionRef}
        panel={{
          entries,
          allEntries: entries,
          bots: [],
          onSelect: search.select,
          onSupersede: search.supersede,
          onCancel: search.cancel
        }}
      >
        <div ref={listRef}>Ordinary list</div>
      </BotSidebarSearchHost>
    </>
  )
}
function openCrew(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Toggle search' }))
  const field = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(field, { target: { value: 'crew' } })
  return field
}
beforeEach(() => {
  mocks.openGroup.mockReset()
  mocks.onOpenBot.mockReset()
  mocks.error.mockReset()
  vi.stubGlobal('api', { ui: { set: async () => {} } })
  useAppStore.setState({ collapsedGroups: new Set(['bots']) })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('ignores a group completion after focus leaves with no destination and returns', async () => {
  let finish = (): void => {}
  mocks.openGroup.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  render(<Session />)
  const field = openCrew()
  fireEvent.keyDown(field, { key: 'Enter' })
  act(() => field.blur())
  act(() => field.focus())
  await act(async () => finish())
  expect(screen.getByRole('searchbox')).toBe(field)
  expect(document.activeElement).toBe(field)
  expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
  expect(mocks.onOpenBot).not.toHaveBeenCalled()
})
it('ignores a group rejection after focus leaves with no destination and returns', async () => {
  let fail = (): void => {}
  mocks.openGroup.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error('gone'))
      })
  )
  render(<Session />)
  const field = openCrew()
  fireEvent.keyDown(field, { key: 'Enter' })
  act(() => field.blur())
  act(() => field.focus())
  await act(async () => fail())
  expect(screen.getByRole('searchbox')).toBe(field)
  expect(document.activeElement).toBe(field)
  expect(mocks.error).not.toHaveBeenCalled()
})
it('ends the pending search when the last bot disappears but its group remains', async () => {
  let finish = (): void => {}
  mocks.openGroup.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const view = render(<Session />)
  const field = openCrew()
  fireEvent.keyDown(field, { key: 'Enter' })
  view.rerender(<Session entries={groupOnly} />)
  expect(screen.queryByRole('searchbox')).toBeNull()
  const reopened = openCrew()
  await act(async () => finish())
  expect(screen.getByRole('searchbox')).toBe(reopened)
  expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
  expect(mocks.onOpenBot).not.toHaveBeenCalled()
  fireEvent.keyDown(reopened, { key: 'Enter' })
  await act(async () => finish())
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(mocks.onOpenBot).toHaveBeenCalledOnce()
})
it('offers expansion when every saved fold belongs to a hidden bot', () => {
  useAppStore.setState({ collapsedGroups: new Set(['lineage:folder:session-home']) })
  const { result } = renderHook(() => useBotCollapseAll([], [botEntry]))
  expect(result.current?.allCollapsed).toBe(true)
  act(() => result.current!.toggle())
  expect(useAppStore.getState().collapsedGroups.has('lineage:folder:session-home')).toBe(false)
})
it('offers expansion for a hidden saved fold beside a childless visible bot', () => {
  const visible = { kind: 'bot' as const, id: 'childless', home: { id: 'childless-home' } }
  useAppStore.setState({
    collapsedGroups: new Set(['lineage:folder:session-home', 'repo:outside'])
  })
  const { result } = renderHook(() => useBotCollapseAll([visible], [visible, botEntry]))
  expect(result.current?.allCollapsed).toBe(true)
  act(() => result.current!.toggle())
  expect(useAppStore.getState().collapsedGroups.has('lineage:folder:session-home')).toBe(false)
  expect(useAppStore.getState().collapsedGroups.has('repo:outside')).toBe(true)
})
it('keeps fold actions current through unrelated, individual and bulk fold changes', async () => {
  const { setBotSidebarChildren } = await import('./bot-sidebar-child-presence')
  const { setAllProjectsCollapsed } =
    await import('../sidebar/worktree-list/listing/project-collapse-all')
  useAppStore.setState({ collapsedGroups: new Set(['project-group:hidden', 'pinned']) })
  setBotSidebarChildren('session-bot', { workspaces: true })
  const entries = [botEntry]
  const { result } = renderHook(() => useBotCollapseAll(entries, entries))
  expect(result.current?.allCollapsed).toBe(false)
  act(() => result.current!.toggle())
  expect(result.current?.allCollapsed).toBe(true)
  act(() =>
    useAppStore
      .getState()
      .setCollapsedGroups(
        setAllProjectsCollapsed(useAppStore.getState().collapsedGroups, ['repo:outside'], true)
      )
  )
  expect(result.current?.allCollapsed).toBe(true)
  act(() =>
    useAppStore
      .getState()
      .setCollapsedGroups(
        setAllProjectsCollapsed(useAppStore.getState().collapsedGroups, ['repo:outside'], false)
      )
  )
  expect(result.current?.allCollapsed).toBe(true)
  expect(useAppStore.getState().collapsedGroups.has('project-group:hidden')).toBe(false)
  expect(useAppStore.getState().collapsedGroups.has('pinned')).toBe(false)
  act(() => useAppStore.getState().toggleCollapsedGroup('repo:outside'))
  expect(result.current?.allCollapsed).toBe(true)
  act(() => useAppStore.getState().toggleCollapsedGroup('lineage:folder:session-home'))
  expect(result.current?.allCollapsed).toBe(false)
  act(() =>
    useAppStore
      .getState()
      .setCollapsedGroups(new Set(['lineage:folder:session-home', 'repo:outside']))
  )
  expect(result.current?.allCollapsed).toBe(true)
  act(() => result.current!.toggle())
  expect(useAppStore.getState().collapsedGroups.has('lineage:folder:session-home')).toBe(false)
  expect(useAppStore.getState().collapsedGroups.has('repo:outside')).toBe(true)
})
it('selects the current group after closing and reopening search with a changed catalog', async () => {
  mocks.openGroup.mockResolvedValue(undefined)
  const view = render(<Session />)
  const field = openCrew()
  fireEvent.keyDown(field, { key: 'Escape' })
  const renamed = { ...groupEntry, group: { ...groupEntry.group, name: 'New crew' } }
  view.rerender(<Session entries={[botEntry, renamed]} />)
  const reopened = openCrew()
  fireEvent.keyDown(reopened, { key: 'Enter' })
  await act(async () => {})
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(mocks.onOpenBot).toHaveBeenCalledOnce()
})
