// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../../shared/bots/bot-sidebar-view'
import {
  advanceBotPaletteGeneration,
  revealBotSidebarRow,
  revealBotSidebarRowAfterOpen,
  setBotSidebarSearchHasQuery
} from './reveal-bot-sidebar-row'

const initialAppState = useAppStore.getInitialState()
const CHAT_TAB = 'chat-tab-b1'

function botsFolded(): boolean {
  return useAppStore.getState().collapsedGroups.has(BOTS_GROUP_KEY)
}

/** The opened chat's pane with its composer, and an unrelated control in the same workspace. */
function mountDestination(): { composer: HTMLTextAreaElement; elsewhere: HTMLButtonElement } {
  const workspace = document.createElement('div')
  const pane = document.createElement('div')
  pane.dataset.structuredAgentSessionOverlayTabId = CHAT_TAB
  const composer = document.createElement('textarea')
  pane.append(composer)
  const elsewhere = document.createElement('button')
  workspace.append(pane, elsewhere)
  document.body.append(workspace)
  return { composer, elsewhere }
}

/** The Bots list as the sidebar draws it once unfolded, with rows from two hosts sharing an id. */
function mountList(): HTMLElement {
  const list = document.createElement('div')
  list.dataset.botSidebarList = ''
  for (const key of ['local/b1', 'remote/b1']) {
    const row = document.createElement('div')
    row.dataset.botSidebarEntry = key
    const name = document.createElement('button')
    name.dataset.worktreeTitleInlineRename = ''
    name.textContent = key
    row.append(name)
    list.append(row)
  }
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 80))
  for (const row of list.children) {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 160, 240, 40))
  }
  document.body.append(list)
  return list
}

/** Frames and the wall clock move together under fake timers, so the reveal's deadline is exact. */
async function settle(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('revealing a bot row', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance'
      ]
    })
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      sidebarOpen: true,
      sidebarBody: 'workspaces',
      collapsedGroups: new Set(),
      botSidebarView: DEFAULT_BOT_SIDEBAR_VIEW
    })
    setBotSidebarSearchHasQuery(false)
  })

  afterEach(() => {
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function revealB1(paused = false, listed = () => true): void {
    revealBotSidebarRowAfterOpen({
      sidebarKey: 'local/b1',
      readEntry: () => (listed() ? { kind: 'bot', paused } : null),
      generation: advanceBotPaletteGeneration(),
      destinationTabId: CHAT_TAB
    })
  }

  it('scrolls an already open Bots list once its chat holds focus, leaving focus there', async () => {
    const list = mountList()
    const { composer } = mountDestination()
    composer.focus()
    revealB1()
    await settle()
    expect(botsFolded()).toBe(false)
    expect(list.scrollTop).toBe(120)
    expect(document.activeElement).toBe(composer)
  })

  it('keeps a folded Bots section closed without scrolling after its chat opens', async () => {
    useAppStore.setState({ collapsedGroups: new Set([BOTS_GROUP_KEY]) })
    const list = mountList()
    const { composer } = mountDestination()
    composer.focus()
    revealB1()
    await settle()
    expect(botsFolded()).toBe(true)
    expect(list.scrollTop).toBe(0)
    expect(document.activeElement).toBe(composer)
  })

  it('does not scroll when the bot is gone by the time its chat holds focus', async () => {
    const list = mountList()
    const { composer } = mountDestination()
    composer.focus()
    revealB1(false, () => false)
    await settle()
    expect(list.scrollTop).toBe(0)
  })

  it('does not scroll when focus is elsewhere in the same workspace', async () => {
    const list = mountList()
    const { elsewhere } = mountDestination()
    elsewhere.focus()
    revealB1()
    await settle(650)
    expect(list.scrollTop).toBe(0)
  })

  it('does not scroll when a newer palette selection or opening came first', async () => {
    const list = mountList()
    const { composer } = mountDestination()
    composer.focus()
    revealB1()
    advanceBotPaletteGeneration()
    await settle()
    expect(list.scrollTop).toBe(0)
  })

  it.each([
    ['the sidebar is hidden', () => useAppStore.setState({ sidebarOpen: false }), false],
    ['the sidebar shows Agents', () => useAppStore.setState({ sidebarBody: 'agents' }), false],
    [
      'a paused bot is hidden by its view option',
      () =>
        useAppStore.setState({
          botSidebarView: { ...DEFAULT_BOT_SIDEBAR_VIEW, hidePausedBots: true }
        }),
      true
    ],
    ['the sidebar search is showing results', () => setBotSidebarSearchHasQuery(true), false]
  ])('changes nothing when %s', async (_case, arrange, paused) => {
    const list = mountList()
    const { composer } = mountDestination()
    composer.focus()
    arrange()
    revealB1(paused)
    await settle()
    expect(list.scrollTop).toBe(0)
  })

  it("focuses the host-qualified row's name only when asked, and only while still current", async () => {
    mountList()
    useAppStore.setState({ collapsedGroups: new Set([BOTS_GROUP_KEY]) })
    let current = true
    revealBotSidebarRow({ sidebarKey: 'remote/b1', focusName: true, isCurrent: () => current })
    await settle()
    expect(document.activeElement?.textContent).toBe('remote/b1')

    const before = document.activeElement
    current = false
    revealBotSidebarRow({ sidebarKey: 'local/b1', focusName: true, isCurrent: () => current })
    await settle()
    expect(document.activeElement).toBe(before)
  })
})
