import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeLapsedManualUnreadProtections } from '@/attention/agent-attention-acknowledgement'
import { writeWebChatReadMarkEdits } from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import { paneKeyLeaf } from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { diffPersistedUIWriteFields } from '../../ui/persisted-ui-write-baseline'
import { makePersistedUI } from '../../ui/ui-slice-test-harness'
import { readWebChatMark } from './chat-read-mark-aliases'
import { browserChatMarks, CHAT, OLD, TAB } from './chat-read-mark-web-test-fixture'

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(10_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  [600, 500],
  [500, 600]
])('resolves cutoff collisions (%i, %i) and keeps protection for the live turn', (old, chat) => {
  const unrelated: Record<string, number> = {}
  for (let index = 1; index <= 499; index++) {
    unrelated[`terminal-${index}:pane`] = index
  }
  const marks = browserChatMarks({
    sidebarOpen: false,
    activityClearedAtByPaneKey: { ...unrelated, [OLD]: old, [CHAT]: chat },
    manuallyUnreadTurnsByPaneKey: { [OLD]: 100, [CHAT]: 200 }
  })
  const { store } = marks.open(undefined, 100)

  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(marks.stored()).toEqual({
    sidebarOpen: false,
    activityClearedAtByPaneKey: { ...unrelated, [CHAT]: 600 },
    manuallyUnreadTurnsByPaneKey: { [CHAT]: 100 }
  })
  expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({ [CHAT]: 100 })
})

it('uses the same live protection in the pending reader and lapse pass', () => {
  vi.mocked(performance.now).mockReturnValue(120_000)
  const unrelated: Record<string, number> = {}
  for (let index = 1; index <= 499; index++) {
    unrelated[`terminal-${index}:pane`] = index
  }
  const marks = browserChatMarks({
    activityClearedAtByPaneKey: { [CHAT]: 50, [OLD]: 200 },
    manuallyUnreadTurnsByPaneKey: { ...unrelated, [CHAT]: 100, [OLD]: 200 }
  })
  const { store } = marks.open(undefined, 200)
  const state = store.getState()

  expect(state.manuallyUnreadTurnsByPaneKey).toEqual({ ...unrelated, [CHAT]: 100, [OLD]: 200 })
  expect(readWebChatMark(state, 'activityClearedAtByPaneKey', CHAT)).toBe(200)
  expect(readWebChatMark(state, 'manuallyUnreadTurnsByPaneKey', CHAT, 200)).toBe(200)
  const lapsed = computeLapsedManualUnreadProtections(
    {
      liveTurns: state.agentStatusByPaneKey,
      manuallyUnreadTurnStartedAt: state.manuallyUnreadTurnsByPaneKey
    },
    new Set([CHAT])
  )
  expect(lapsed).not.toContain(CHAT)
  expect(lapsed).not.toContain(OLD)
})

it('keeps the live-turn alias at the cap when the startup move fails', () => {
  const protections: Record<string, number> = { [OLD]: 100, [CHAT]: 200 }
  for (let index = 0; index < 499; index++) {
    protections[`terminal-${index}:pane`] = 300 + index
  }
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: protections })
  marks.localStorage.setItem.mockImplementationOnce(() => {
    throw new Error('Storage quota reached')
  })

  const { store } = marks.open(undefined, 100)

  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual(protections)
  expect(readWebChatMark(store.getState(), 'manuallyUnreadTurnsByPaneKey', CHAT, 100)).toBe(100)
})

it('preserves tied cutoffs when chats with pending aliases move in separate receipts', () => {
  const terminals: Record<string, number> = {}
  for (let index = 1; index <= 498; index++) {
    terminals[`terminal-${index}:pane`] = index
  }
  const otherChat = chatPaneKey('session-3')
  const otherAlias = `agent-chat-tab-v1-other:${paneKeyLeaf(otherChat)}`
  const secondAlias = `agent-chat-tab-v1-reopened:${paneKeyLeaf(CHAT)}`
  const marks = browserChatMarks({
    activityClearedAtByPaneKey: { [otherAlias]: 1, ...terminals, [OLD]: 600, [secondAlias]: 550 }
  })
  const { receive } = marks.open()

  receive([{ ...TAB, id: 'agent-chat-tab-v1-other', sessionId: 'session-3' }])
  expect(Object.keys(marks.stored().activityClearedAtByPaneKey ?? {})[0]).toBe(otherChat)
  receive([TAB])

  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(2)
  expect(marks.open().store.getState().activityClearedAtByPaneKey).toEqual({
    [otherChat]: 1,
    ...terminals,
    [CHAT]: 600
  })
})

it.each([500, 501])('caps %i unrelated cutoffs at load and keeps the pending alias', (count) => {
  const cutoffs: Record<string, number> = { [OLD]: 1 }
  for (let index = 1; index <= count; index++) {
    cutoffs[`terminal-${index}:pane`] = index + 1
  }
  const marks = browserChatMarks({ activityClearedAtByPaneKey: cutoffs })
  const hydrated = marks.open().store.getState().activityClearedAtByPaneKey

  expect(Object.keys(hydrated)).toHaveLength(501)
  expect(hydrated[OLD]).toBe(1)
  expect(hydrated['terminal-1:pane']).toBe(count === 500 ? 2 : undefined)
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()
})

it('preserves all held cutoffs when Clear completed is saved and then undone at the cap', () => {
  const cutoffs: Record<string, number> = {}
  for (let index = 1; index <= 500; index++) {
    cutoffs[`terminal-${index}:pane`] = index
  }
  const marks = browserChatMarks({ activityClearedAtByPaneKey: cutoffs })
  const { store } = marks.open()
  const save = () => {
    const state = store.getState()
    const baseline = state.persistedUIWriteBaseline
    if (!baseline) {
      throw new Error('Expected a hydrated UI baseline')
    }
    const persisted = writeWebChatReadMarkEdits(
      diffPersistedUIWriteFields(state, baseline),
      baseline
    )
    store.setState({ ...persisted, persistedUIWriteBaseline: { ...baseline, ...persisted } })
  }

  store.getState().applyActivityClearedAt({ [CHAT]: 600 })
  save()
  expect(store.getState().activityClearedAtByPaneKey).toEqual({ ...cutoffs, [CHAT]: 600 })

  store.getState().applyActivityClearedAt({ [CHAT]: null })
  save()
  expect(marks.stored().activityClearedAtByPaneKey).toEqual(cutoffs)
  expect(marks.open().store.getState().activityClearedAtByPaneKey).toEqual(cutoffs)
})

it('retires an alias on Undo after the receipt window and preserves it on reload', () => {
  const marks = browserChatMarks({ activityClearedAtByPaneKey: { [OLD]: 200 } })
  const { store, receive } = marks.open()
  vi.mocked(performance.now).mockReturnValue(120_000)
  receive([TAB])
  const baseline = store.getState().persistedUIWriteBaseline
  if (!baseline) {
    throw new Error('Expected a hydrated UI baseline')
  }

  store.getState().applyActivityClearedAt({ [CHAT]: 50 })
  writeWebChatReadMarkEdits(diffPersistedUIWriteFields(store.getState(), baseline), baseline)

  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(marks.stored().activityClearedAtByPaneKey).toEqual({ [CHAT]: 50 })
  expect(marks.open().store.getState().activityClearedAtByPaneKey).toEqual({ [CHAT]: 50 })
})

it('applies a stale tab’s pending Mark read to a protection already moved by another tab', () => {
  const initial = { manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } }
  const marks = browserChatMarks(initial)
  marks.open().receive([TAB])
  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual({ [CHAT]: 200 })

  const { store, receive } = marks.open(initial)
  store.getState().acknowledgeAgents([CHAT], [], 'explicit')
  receive([TAB])

  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual({})
  expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({})
  expect(store.getState().persistedUIWriteBaseline?.manuallyUnreadTurnsByPaneKey).toEqual({})
})

it('adopts a stored deletion while retaining an unrelated pending edit', () => {
  const marks = browserChatMarks({
    activityClearedAtByPaneKey: { [OLD]: 200 },
    manuallyUnreadTurnsByPaneKey: { [OLD]: 300 }
  })
  const { store } = marks.open()
  store.getState().applyActivityClearedAt({ 'terminal:pane': 400 })
  store.setState({ sidebarWidth: 420 })
  const deleted = { activityClearedAtByPaneKey: {}, manuallyUnreadTurnsByPaneKey: {} }
  marks.replaceStored(JSON.stringify(deleted))
  store.getState().hydratePersistedUI(makePersistedUI(deleted), 'sync')

  expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({})
  expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'terminal:pane': 400 })
  expect(store.getState().sidebarWidth).toBe(420)
  expect(store.getState().persistedUIWriteBaseline?.activityClearedAtByPaneKey).toEqual({})
})

it('keeps the legacy source after a rejected write and retries on the next load', () => {
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } })
  const { store, receive } = marks.open()
  marks.localStorage.setItem.mockImplementationOnce(() => {
    throw new Error('Storage quota reached')
  })

  receive([TAB])
  receive([TAB])
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual({ [OLD]: 200 })
  expect(readWebChatMark(store.getState(), 'manuallyUnreadTurnsByPaneKey', CHAT, 200)).toBe(200)

  marks.open().receive([TAB])
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(2)
  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual({ [CHAT]: 200 })
})

it('leaves malformed storage alone when a receipt matches', () => {
  const marks = browserChatMarks({ activityClearedAtByPaneKey: { [OLD]: 200 } })
  const { store, receive } = marks.open()
  const malformed = '{"sidebarOpen":false,'
  marks.replaceStored(malformed)

  receive([TAB])
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()
  expect(marks.localStorage.getItem('orca.web.ui.v1')).toBe(malformed)
  expect(readWebChatMark(store.getState(), 'activityClearedAtByPaneKey', CHAT)).toBe(200)
})
