import { afterEach, expect, it, vi } from 'vitest'
import { computeLapsedManualUnreadProtections } from '@/attention/agent-attention-acknowledgement'
import { UI_STORAGE_KEY } from '@/web/preload-api/web-storage'
import { writeWebChatReadMarkEdits } from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import { hostSnapshotAffirmsAgentSessions } from '../../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import type { RuntimeMobileSessionAgentTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { PersistedUIState } from '../../../../../../shared/orca-profiles/persisted-ui-state-types'
import { diffPersistedUIWriteFields } from '../../ui/persisted-ui-write-baseline'
import { createUIStore, makePersistedUI } from '../../ui/ui-slice-test-harness'
import {
  isWebChatReadMarkCopyPending,
  readWebChatMark,
  receivePairedChatReadMarkCandidates,
  receiveWebChatReadMarkCensus,
  receiveWebChatReadMarkFrame
} from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const OLD = `agent-chat-tab-v1-abc:${LEAF}`
const REPLACED = `structured-agent-session-old:${LEAF}`
const CHAT = `structured-agent-session-sess-2:${LEAF}`
const TERMINAL = 'terminal-tab:pane-0'
const OTHER_TERMINAL = 'another-terminal:pane-0'
const CHAT_TAB: RuntimeMobileSessionAgentTab = {
  type: 'agent-session',
  id: 'agent-chat-tab-v1-abc',
  sessionId: 'sess-2',
  title: 'Chat',
  agent: 'codex',
  isActive: true
}

function load(initial: Partial<PersistedUIState>) {
  let json = JSON.stringify(initial)
  const localStorage = {
    getItem: (key: string) => (key === UI_STORAGE_KEY ? json : null),
    setItem: vi.fn((_key: string, value: string) => {
      json = value
    })
  }
  vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true, localStorage })
  const stored = (): Partial<PersistedUIState> => JSON.parse(json)
  const reload = () => {
    const fresh = createUIStore()
    fresh.setState({ unifiedTabsByWorktree: {} })
    fresh.getState().hydratePersistedUI(makePersistedUI(stored()), 'startup')
    return fresh
  }
  const store = reload()
  const records = new Map<string, object>([
    ['w1', {}],
    ['w2', {}]
  ])
  const frame = (
    worktreeId: string,
    tabs: readonly RuntimeMobileSessionAgentTab[],
    unconfirmed = false,
    censusMember = false
  ) => {
    const copied = receiveWebChatReadMarkFrame(store.getState(), {
      environmentId: 'paired',
      runtimeId: 'runtime',
      worktreeId,
      trackingRecord: records.get(worktreeId),
      affirmsChats: hostSnapshotAffirmsAgentSessions({
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        ...(unconfirmed && { agentSessionsUnverifiable: true as const })
      }),
      tabs,
      censusMember
    })
    if (copied) {
      store.setState(copied)
    }
  }
  const census = (...workspaceIds: string[]) => {
    const copied = receiveWebChatReadMarkCensus(
      store.getState(),
      'paired',
      'runtime',
      workspaceIds.map((id) => [id, records.get(id)] as const)
    )
    if (copied) {
      store.setState(copied)
    }
  }
  return {
    store,
    localStorage,
    stored,
    reload,
    frame,
    census,
    replaceStored: (ui: Partial<PersistedUIState>) => {
      json = JSON.stringify(ui)
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

it('copies once at startup, choosing the largest source and keeping stored destinations and originals', () => {
  const marks = load({
    activityClearedAtByPaneKey: { [OLD]: 50, [CHAT]: 20 },
    manuallyUnreadTurnsByPaneKey: { [OLD]: 70, [REPLACED]: 80 }
  })
  marks.frame('w1', [CHAT_TAB], false, true)
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()
  marks.census('w1')
  marks.census('w1')
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(marks.stored()).toEqual({
    activityClearedAtByPaneKey: { [OLD]: 50, [CHAT]: 20 },
    manuallyUnreadTurnsByPaneKey: { [OLD]: 70, [REPLACED]: 80, [CHAT]: 80 },
    chatReadMarksCopiedHere: true
  })

  const noLegacy = load({ activityClearedAtByPaneKey: { [TERMINAL]: 50, [CHAT]: 20 } })
  expect(noLegacy.localStorage.setItem).toHaveBeenCalledTimes(1)
  expect(noLegacy.store.getState().chatReadMarksCopiedHere).toBe(true)
})

it('uses a stream receipt that arrived before the census and copies chats already in the store', () => {
  const marks = load({ activityClearedAtByPaneKey: { [OLD]: 50 } })
  marks.store.setState({
    unifiedTabsByWorktree: {
      w1: [
        {
          id: CHAT_TAB.id,
          entityId: 'sess-2',
          groupId: 'group',
          worktreeId: 'w1',
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  marks.frame('w1', [])
  expect(marks.store.getState().chatReadMarksCopiedHere).toBe(false)
  marks.census('w1')
  expect(marks.stored().activityClearedAtByPaneKey).toEqual({ [OLD]: 50, [CHAT]: 50 })
})

it('waits through empty and unconfirmed censuses, and retries a failed write at the next census', () => {
  const marks = load({ manuallyUnreadTurnsByPaneKey: { [OLD]: 70 } })
  marks.census()
  marks.frame('w1', [CHAT_TAB], true, true)
  marks.census('w1')
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()
  marks.localStorage.setItem.mockImplementationOnce(() => {
    throw new Error('Storage quota reached')
  })
  marks.frame('w1', [CHAT_TAB])
  expect(marks.store.getState().manuallyUnreadTurnsByPaneKey).toEqual({ [OLD]: 70 })
  expect(marks.store.getState().chatReadMarksCopiedHere).toBe(false)
  marks.frame('w1', [], true)
  marks.frame('w1', [CHAT_TAB])
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
  marks.census('w1')
  expect(marks.stored().manuallyUnreadTurnsByPaneKey).toEqual({ [OLD]: 70, [CHAT]: 70 })
  expect(marks.store.getState().chatReadMarksCopiedHere).toBe(true)
})

it('does not refill a cleared copy from a retained original after reload', () => {
  const marks = load({ activityClearedAtByPaneKey: { [OLD]: 50 } })
  marks.frame('w1', [CHAT_TAB], false, true)
  marks.census('w1')
  const state = marks.store.getState()
  state.applyActivityClearedAt({ [CHAT]: null })
  writeWebChatReadMarkEdits(
    diffPersistedUIWriteFields(marks.store.getState(), state.persistedUIWriteBaseline!),
    state.persistedUIWriteBaseline!
  )
  const reloaded = marks.reload().getState()
  expect(reloaded.chatReadMarksCopiedHere).toBe(true)
  expect(readWebChatMark(reloaded, 'activityClearedAtByPaneKey', CHAT)).toBeUndefined()
  expect(marks.stored().activityClearedAtByPaneKey).toEqual({ [OLD]: 50 })
})

it('keeps an on-screen chat protected by the matching hash and lapses it on switch-away', () => {
  const marks = load({ manuallyUnreadTurnsByPaneKey: { [OLD]: 70, [REPLACED]: 60 } })
  const state = marks.store.getState()
  const records = {
    liveTurns: new Map([[CHAT, { stateStartedAt: 70 }]]),
    manuallyUnreadTurnStartedAt: state.manuallyUnreadTurnsByPaneKey,
    chatReadMarksCopiedHere: state.chatReadMarksCopiedHere
  }
  expect(readWebChatMark(state, 'manuallyUnreadTurnsByPaneKey', CHAT)).toBe(70)
  expect(computeLapsedManualUnreadProtections(records, new Set([CHAT]))).toEqual([])
  const lapsed = computeLapsedManualUnreadProtections(records, new Set([TERMINAL]))
  expect(lapsed).toEqual([OLD, REPLACED])
  state.clearManuallyUnreadTurns(lapsed)
  expect(readWebChatMark(marks.store.getState(), 'manuallyUnreadTurnsByPaneKey', CHAT)).toBeUndefined()
})

it('merges pending edits by key and respects another tab’s stored values and completion', () => {
  for (const otherTabFinished of [false, true]) {
    const marks = load({
      activityClearedAtByPaneKey: { [OLD]: 70, [TERMINAL]: 20, [OTHER_TERMINAL]: 40 },
      manuallyUnreadTurnsByPaneKey: { [OLD]: 80 }
    })
    marks.store.getState().applyActivityClearedAt({ [TERMINAL]: null, [CHAT]: 55 })
    marks.replaceStored({
      activityClearedAtByPaneKey: { [OLD]: 70, [TERMINAL]: 20, [OTHER_TERMINAL]: 90 },
      manuallyUnreadTurnsByPaneKey: { [OLD]: 80 },
      chatReadMarksCopiedHere: otherTabFinished
    })
    marks.frame('w1', [CHAT_TAB], false, true)
    marks.census('w1')
    const state = marks.store.getState()
    expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
    expect(marks.stored()).toEqual({
      activityClearedAtByPaneKey: { [OLD]: 70, [CHAT]: 55, [OTHER_TERMINAL]: 90 },
      manuallyUnreadTurnsByPaneKey: { [OLD]: 80, ...(!otherTabFinished && { [CHAT]: 80 }) },
      chatReadMarksCopiedHere: true
    })
    expect(state.manuallyUnreadTurnsByPaneKey).toEqual(marks.stored().manuallyUnreadTurnsByPaneKey)
    expect(diffPersistedUIWriteFields(state, state.persistedUIWriteBaseline!)).toEqual({})
  }
})

it('skips unchanged tab lists and releases the receipt and fallback state after completion', () => {
  const marks = load({ manuallyUnreadTurnsByPaneKey: { [OLD]: 70 } })
  let rowsRead = 0
  const tabs = new Proxy([CHAT_TAB], {
    get: (target, key) => {
      if (key === '0') {
        rowsRead += 1
      }
      return Reflect.get(target, key)
    }
  })
  marks.frame('w1', tabs)
  expect(rowsRead).toBe(1)
  marks.frame('w1', tabs, false, true)
  expect(rowsRead).toBe(1)
  marks.census('w1')
  const state = marks.store.getState()
  expect(isWebChatReadMarkCopyPending()).toBe(false)
  const forbidden = new Proxy({} as never, {
    get: () => {
      throw new Error('Read receipt after completion')
    }
  })
  expect(receiveWebChatReadMarkFrame(state, forbidden)).toBeUndefined()
  expect(receiveWebChatReadMarkCensus(state, 'paired', 'runtime', forbidden)).toBeUndefined()
  expect(
    readWebChatMark(
      { ...state, manuallyUnreadTurnsByPaneKey: { [OLD]: 70 } },
      'manuallyUnreadTurnsByPaneKey',
      CHAT
    )
  ).toBeUndefined()
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
})

it('copies a chat observed in a paired list reply even if it closed before coverage completed', () => {
  const marks = load({ activityClearedAtByPaneKey: { [OLD]: 50 } })
  receivePairedChatReadMarkCandidates(marks.store.getState(), [CHAT_TAB])
  marks.frame('w1', [], false, true)
  marks.census('w1')
  expect(marks.stored().activityClearedAtByPaneKey).toEqual({ [OLD]: 50, [CHAT]: 50 })
})
