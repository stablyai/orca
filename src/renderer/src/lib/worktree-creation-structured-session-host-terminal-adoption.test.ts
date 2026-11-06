// @vitest-environment happy-dom

// A held host launch whose host started its terminal instead: the chat gives way to that terminal
// once this window draws it in the chat's place.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import type * as launchModule from './agent-session/launch/structured-agent-session-launch-create-call'
import type * as recordModule from './agent-session/launch/structured-agent-session-launch-record'
import type * as tabIndexModule from './agent-session/launch/structured-agent-session-launch-tab-index'
import type * as terminalSurfaceModule from '../../../shared/workspace-layout/terminal-surface-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { workspaceTerminalForHostTab } from './agent-session/launch/structured-agent-session-launch-tab-index'
import { structuredAgentLaunchRecordFor } from './agent-session/launch/structured-agent-session-launch-record'
import { restorePersistedStructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-reload'
import {
  getStructuredAgentSessionLaunchFailure,
  resetStructuredAgentLaunchRegistryForTests,
  subscribeStructuredAgentLaunchStatus
} from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import { retryStructuredAgentSessionLaunch } from './agent-session/launch/structured-agent-session-launch'
import { restoreStructuredLaunchSurfaces } from './agent-session/launch/structured-agent-session-launch-restore'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/native-chat-composer-draft-store'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { holdDrawnTabs } from '@/runtime/layout-owner-drawn-tab-holds'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>(),
  hostLaunch: vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})),
  // Every method this window asked a host.
  rpc: [] as string[]
}))
// Every terminal tab id this window decodes to its host's tab, whoever asks.
const scans = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../shared/workspace-layout/terminal-surface-id', async (original) => {
  const surface = await original<typeof terminalSurfaceModule>()
  return {
    ...surface,
    toHostSessionTabId: (id: string) => {
      scans.count++
      return surface.toHostSessionTabId(id)
    }
  }
})
// Counts each look a waiting launch takes into its workspace's terminals.
vi.mock('./agent-session/launch/structured-agent-session-launch-tab-index', async (original) => {
  const index = await original<typeof tabIndexModule>()
  return { ...index, workspaceTerminalForHostTab: vi.fn(index.workspaceTerminalForHostTab) }
})
// Counts each launch row this window prepares for saving, by the launch it describes.
vi.mock('./agent-session/launch/structured-agent-session-launch-record', async (original) => {
  const record = await original<typeof recordModule>()
  return { ...record, structuredAgentLaunchRecordFor: vi.fn(record.structuredAgentLaunchRecordFor) }
})
vi.mock('./agent-session/launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.createSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) =>
      mocks.rpc.push(args[1]) &&
      (args[1].startsWith('agent.launch') || args[1] === 'agentSession.history')
        ? mocks.hostLaunch(args[1], args[2])
        : client.callRuntimeRpc(...args)
  }
})
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)

const initialState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const LAUNCHES = 'orca:structuredAgentLaunches:v1'
const HELD = 'Recover this first message'
const TERMINAL_TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
// A saved held row: fixed launch fields, the held message and one failure explanation.
const SAVED_ROW_CHARS = 1_000
let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.rpc.length = 0
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  mocks.createSession.mockReturnValue(new Promise(() => {}))
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  localStorage.removeItem(LAUNCHES)
  useAppStore.setState(initialState, true)
})

const acceptCalls = (): Record<string, unknown>[] =>
  mocks.hostLaunch.mock.calls
    .filter(([method]) => method === 'agent.launchAccept')
    .map(([, params]) => params as Record<string, unknown>)
const chatTabs = (sessionId: string) =>
  (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).filter(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
const moves = () => layoutApplyTestTransport.sent.filter((command) => command.type === 'moveTab')

/** A saved host launch still holding its first message, as this window writes it. */
const held = (sessionId: string, worktreeId = worktree.id) => ({
  sessionId,
  executionHostId: 'local',
  agent: 'codex',
  lifecycle: 'pending',
  clientOperationId: `op-${sessionId}`,
  payloadFingerprint: 'fingerprint',
  expectedRuntimeFence: null,
  hostLaunchOperationId: `host-op-${sessionId}`,
  surfaceAddress: { worktreeId, precedingTabIds: [] },
  firstMessage: {
    clientMessageId: `held-${sessionId}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: HELD }] }
  }
})

/** The host's answers: each status read gives `status()`. */
function hostReplies(status: (params: { operationId?: string }) => Promise<unknown>): void {
  mocks.hostLaunch.mockImplementation(async (method, params) =>
    method === 'agent.launchAccept'
      ? { state: 'running' }
      : status(params as { operationId?: string })
  )
}

/** The host started the agent in a terminal, naming the pane it drew under `terminalTab`. */
const terminalAnswer = (terminalTab: string | null) => ({
  state: 'succeeded',
  result: {
    outcome: {
      kind: 'terminal',
      handle: 'term_1',
      // A terminal result may name no pane: the chat cannot find it then.
      ...(terminalTab ? { paneKey: `${terminalTab}:3f2504e0-4f89-41d3-9a0c-0305e82c3301` } : {})
    },
    worktreeId: worktree.id,
    receipt: {
      mode: 'terminal',
      preferred: 'structured',
      reason: 'structured_unsupported_on_host',
      detail: ''
    },
    prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
  }
})

/** Counts the store watches open from here until `restore()`; `subscribe` watches uncounted. */
function countStoreWatches() {
  const subscribe = useAppStore.subscribe
  const watches = { live: 0, subscribe, restore: () => void (useAppStore.subscribe = subscribe) }
  useAppStore.subscribe = (listener) => {
    watches.live++
    const stop = subscribe(listener)
    return () => {
      watches.live--
      stop()
    }
  }
  return watches
}

/** The user pins, names and colors a tab, as the tab strip does. */
function dressAsUser(tabId: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    useAppStore.getState().pinTab(tabId)
    useAppStore.getState().setTabCustomLabel(tabId, 'My work')
    useAppStore.getState().setUnifiedTabColor(tabId, '#ff0000')
    return
  }
  const answer = { apply: () => {}, asToday: () => {} }
  sendLayoutCommandToOwner(
    worktree.id,
    { type: 'renameTab', tabId, kind: 'custom', title: 'My work' },
    answer
  )
  sendLayoutCommandToOwner(
    worktree.id,
    { type: 'setTabProps', tabId, color: '#ff0000', isPinned: true },
    answer
  )
}

/** At most two decodes (id, entity id) per terminal of each tab list this workspace shows from
 *  now: what one shared reading of each list costs, however many launches wait on it. */
function decodeBoundPerTabList(subscribe: typeof useAppStore.subscribe): {
  bound: number
  stop: () => void
} {
  const seen = new WeakSet<object>()
  const result = { bound: 0, stop: () => {} }
  result.stop = subscribe((state) => {
    const tabs = state.unifiedTabsByWorktree[worktree.id]
    if (tabs && !seen.has(tabs)) {
      seen.add(tabs)
      result.bound += 2 * tabs.filter((tab) => tab.contentType === 'terminal').length
    }
  })
  return result
}

describe("a host's terminal taking its held chat's place", () => {
  it.each([3, 30])(
    "puts host terminals in their chats' places beside %i held launches, touching only theirs",
    async (count) => {
      const others = Array.from({ length: count - 1 }, (_, index) => `codex-other-${index}`)
      // Two chats follow the one whose terminal is drawn: main must move the terminal past them.
      const ours = ['codex-drawn', 'codex-unnamed', 'codex-never'] as const
      localStorage.setItem(
        LAUNCHES,
        JSON.stringify([
          ...ours.map((sessionId) => held(sessionId)),
          ...others.map((sessionId, index) => held(sessionId, `${worktree.id}-elsewhere-${index}`))
        ])
      )
      resetStructuredAgentLaunchPersistenceForTests()
      restoreStructuredLaunchSurfaces()
      await main.settle()
      dressAsUser(chatTabs('codex-drawn')[0]!.id)
      await main.settle()
      // The other launches are held live in their own workspaces, still waiting on their hosts.
      for (const [index, sessionId] of others.entries()) {
        expect(
          restorePersistedStructuredLaunchState(`${worktree.id}-elsewhere-${index}`, sessionId)
        ).toBeDefined()
      }
      const drawnTab = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
      const terminalOf = new Map([
        ['host-op-codex-drawn', drawnTab],
        ['host-op-codex-never', '6ba7b811-9dad-41d1-80b4-00c04fd430c8']
      ])
      hostReplies(async (params) =>
        terminalAnswer(terminalOf.get(params.operationId ?? '') ?? null)
      )
      const prepared = vi.mocked(structuredAgentLaunchRecordFor)
      const preparedFor = (sessionIds: readonly string[]) =>
        prepared.mock.calls.filter(([intent]) => sessionIds.includes(intent.sessionId)).length
      const saves = vi.spyOn(localStorage, 'setItem')
      const notShown = (sessionId: string) =>
        getStructuredAgentSessionLaunchFailure(worktree.id, sessionId)?.causeText?.includes(
          "couldn't show it here"
        )

      // No pane named: the chat stays, saying so, and only its own launch is saved.
      prepared.mockClear()
      expect(retryStructuredAgentSessionLaunch(worktree.id, 'codex-unnamed')).toBe(true)
      await vi.waitFor(() => expect(notShown('codex-unnamed')).toBe(true))
      await main.settle()
      expect(preparedFor(others)).toBe(0)
      // One save per change of its own: retried, answered, message handed over, failed, explained.
      expect(preparedFor(['codex-unnamed'])).toBeLessThanOrEqual(5)
      const journals = saves.mock.calls.filter(([key]) => key === LAUNCHES).map(([, json]) => json)
      expect(journals.length).toBeLessThanOrEqual(5)
      // Each save writes the journal once: its count + 2 rows, each within one row's size.
      const rows = journals.reduce((sum, json) => sum + (JSON.parse(json) as unknown[]).length, 0)
      expect(rows).toBeLessThanOrEqual(journals.length * (count + 2))
      expect(journals.join('').length).toBeLessThanOrEqual(rows * SAVED_ROW_CHARS)
      expect(chatTabs('codex-unnamed')).toHaveLength(1)

      // Two chats wait for terminals not drawn yet, each with one store watch and one deadline.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
      const watches = countStoreWatches()
      const subscribe = watches.subscribe
      try {
        prepared.mockClear()
        for (const sessionId of ['codex-drawn', 'codex-never']) {
          expect(retryStructuredAgentSessionLaunch(worktree.id, sessionId)).toBe(true)
        }
        await vi.waitFor(() => expect(watches.live).toBe(2))
        // Other workspaces' tab writes, as many as there are launches, look at no tab here.
        scans.count = 0
        for (let index = 0; index < count; index++) {
          useAppStore.setState((state) => ({
            unifiedTabsByWorktree: {
              ...state.unifiedTabsByWorktree,
              [`${worktree.id}-elsewhere-${index}`]: []
            }
          }))
        }
        expect(scans.count).toBe(0)
        // Its own terminal drawn: that chat gives way and its watch ends; the other keeps waiting.
        const decodes = decodeBoundPerTabList(subscribe)
        scans.count = 0
        // Switch-on, this window keeps drawing the terminal where it made it after main answers the
        // move: the chat waits for the move to show, then gives way with no second action.
        const holdDraw = ORCA_LAYOUT_OWNER_IS_MAIN
          ? holdDrawnTabs([{ workspace: worktree.id, ids: [drawnTab] }])
          : null
        useAppStore.getState().createTab(worktree.id, undefined, undefined, { id: drawnTab })
        if (holdDraw) {
          await vi.waitFor(async () => {
            await main.settle()
            expect(moves()).toEqual([expect.objectContaining({ tabId: drawnTab, index: 1 })])
          })
          await main.settle()
          expect(chatTabs('codex-drawn')).toHaveLength(1)
          holdDraw()
        }
        await vi.waitFor(async () => {
          await main.settle()
          expect(chatTabs('codex-drawn')).toEqual([])
        })
        const group = useAppStore.getState().groupsByWorktree[worktree.id]?.[0]
        expect(group?.tabOrder).toEqual([
          drawnTab,
          ...['codex-unnamed', 'codex-never'].map((id) => chatTabs(id)[0]?.id)
        ])
        expect(
          useAppStore.getState().tabsByWorktree[worktree.id]?.find((tab) => tab.id === drawnTab)
        ).toMatchObject({
          customTitle: 'My work',
          color: '#ff0000',
          isPinned: true
        })
        decodes.stop()
        // Waiting chats decode this workspace's terminals once per tab list, never per launch.
        expect(scans.count).toBeLessThanOrEqual(decodes.bound)
        expect(watches.live).toBe(1)
        // The other's deadline passes: its watch ends and the chat says where its terminal went.
        await vi.advanceTimersByTimeAsync(10_000)
        await vi.waitFor(() => expect(notShown('codex-never')).toBe(true))
        expect(watches.live).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        await main.settle()
        expect(preparedFor(others)).toBe(0)
      } finally {
        watches.restore()
        vi.useRealTimers()
      }
      expect(acceptCalls()).toEqual([])
      expect(mocks.rpc).not.toContain('agentSession.send')
    }
  )

  it.each([3, 30])(
    "decodes a workspace's terminals once per tab list for %i launches waiting there",
    async (count) => {
      const waiting = Array.from({ length: count }, (_, index) => `codex-wait-${index}`)
      const tabOf = (prefix: string, index: number) =>
        `${prefix}-9dad-41d1-80b4-${String(index).padStart(12, '0')}`
      localStorage.setItem(LAUNCHES, JSON.stringify(waiting.map((sessionId) => held(sessionId))))
      resetStructuredAgentLaunchPersistenceForTests()
      restoreStructuredLaunchSurfaces()
      await main.settle()
      for (let index = 0; index < count; index++) {
        useAppStore.getState().createTab(worktree.id, undefined, undefined, {
          id: tabOf('6ba7b810', index)
        })
      }
      await main.settle()
      // Each launch's terminal is one this window has not drawn yet.
      hostReplies(async (params) =>
        terminalAnswer(tabOf('6ba7b811', Number(params.operationId?.split('-').at(-1))))
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
      const watches = countStoreWatches()
      const subscribe = watches.subscribe
      const lookups = vi.mocked(workspaceTerminalForHostTab)
      try {
        for (const sessionId of waiting) {
          expect(retryStructuredAgentSessionLaunch(worktree.id, sessionId)).toBe(true)
        }
        await vi.waitFor(() => expect(watches.live).toBe(count))
        // Another workspace's tab write decodes nothing and looks nowhere here.
        scans.count = 0
        lookups.mockClear()
        useAppStore.setState((state) => ({
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [`${worktree.id}-other`]: [] }
        }))
        expect(scans.count).toBe(0)
        expect(lookups).not.toHaveBeenCalled()

        // One unrelated terminal here: every waiter looks once into one shared reading per list.
        const decodes = decodeBoundPerTabList(subscribe)
        const changes = { here: 0 }
        const stopChanges = subscribe((state, previous) => {
          if (
            state.unifiedTabsByWorktree[worktree.id] !==
              previous.unifiedTabsByWorktree[worktree.id] ||
            state.groupsByWorktree[worktree.id] !== previous.groupsByWorktree[worktree.id]
          ) {
            changes.here++
          }
        })
        const stopStatus = subscribeStructuredAgentLaunchStatus(() => changes.here++)
        useAppStore.getState().createTab(worktree.id, undefined, undefined, {
          id: tabOf('6ba7b812', 0)
        })
        await main.settle()
        decodes.stop()
        stopChanges()
        stopStatus()
        expect(watches.live).toBe(count)
        expect(scans.count).toBeLessThanOrEqual(decodes.bound)
        expect(lookups.mock.calls.length).toBeLessThanOrEqual(count * changes.here)

        // A paired host's mirror of some other host tab wakes no one; its mirror of a waited-on tab
        // wakes exactly that launch.
        const mirror = (hostTabId: string) => {
          const id = toWebTerminalSurfaceTabId(`${hostTabId}::3f2504e0-4f89-41d3-9a0c-0305e82c3301`)
          useAppStore.setState((state) => {
            const tabs = state.unifiedTabsByWorktree[worktree.id] ?? []
            const terminal = tabs.find((tab) => tab.contentType === 'terminal')!
            return {
              unifiedTabsByWorktree: {
                ...state.unifiedTabsByWorktree,
                [worktree.id]: [...tabs, { ...terminal, id, entityId: id }]
              }
            }
          })
        }
        mirror(tabOf('6ba7b813', 0))
        expect(watches.live).toBe(count)
        mirror(tabOf('6ba7b811', 0))
        expect(watches.live).toBe(count - 1)
        // The rest reach their deadline: no watch or timer of theirs is left.
        await vi.advanceTimersByTimeAsync(10_000)
        await main.settle()
        expect(watches.live).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        watches.restore()
        vi.useRealTimers()
      }
    }
  )

  it.each(['closes its chat', 'retries its launch'] as const)(
    'changes nothing once the user %s while its terminal waits to show there',
    async (action) => {
      localStorage.setItem(LAUNCHES, JSON.stringify([held('codex-drawn')]))
      resetStructuredAgentLaunchPersistenceForTests()
      restoreStructuredLaunchSurfaces()
      await main.settle()
      // Two tabs follow the chat, so placing its terminal is a real move.
      for (const id of ['6ba7b812-9dad-41d1-80b4-000000000001', TERMINAL_TAB]) {
        useAppStore.getState().createTab(worktree.id, undefined, undefined, { id })
      }
      await main.settle()
      const drawnTab = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
      // The first read reports the terminal; a later attempt's read stays outstanding.
      let answered = false
      hostReplies(async () => {
        if (answered) {
          return new Promise(() => {})
        }
        answered = true
        return terminalAnswer(drawnTab)
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
      const watches = countStoreWatches()
      try {
        expect(retryStructuredAgentSessionLaunch(worktree.id, 'codex-drawn')).toBe(true)
        // Switch-on, main has answered the move but this window still draws the terminal where it
        // made it; switch-off, the terminal is not drawn yet.
        const holdDraw = ORCA_LAYOUT_OWNER_IS_MAIN
          ? holdDrawnTabs([{ workspace: worktree.id, ids: [drawnTab] }])
          : null
        if (holdDraw) {
          useAppStore.getState().createTab(worktree.id, undefined, undefined, { id: drawnTab })
          await vi.waitFor(async () => {
            await main.settle()
            expect(moves()).toHaveLength(1)
          })
        }
        await vi.waitFor(() => expect(watches.live).toBe(1))
        if (action === 'closes its chat') {
          useAppStore.getState().closeUnifiedTab(chatTabs('codex-drawn')[0]!.id)
        } else {
          expect(retryStructuredAgentSessionLaunch(worktree.id, 'codex-drawn')).toBe(true)
        }
        await main.settle()
        // The wait ends with the chat's: no watch or deadline of it is left.
        expect(watches.live).toBe(0)
        const failure = getStructuredAgentSessionLaunchFailure(worktree.id, 'codex-drawn')
        const sent = layoutApplyTestTransport.sent.length
        if (holdDraw) {
          holdDraw()
        } else {
          useAppStore.getState().createTab(worktree.id, undefined, undefined, { id: drawnTab })
        }
        await vi.advanceTimersByTimeAsync(10_000)
        await main.settle()
        // Nothing of the ended wait acts: no move, close, name or color, and the chat stays as left.
        expect(layoutApplyTestTransport.sent.slice(sent)).toEqual([])
        expect(chatTabs('codex-drawn')).toHaveLength(action === 'closes its chat' ? 0 : 1)
        expect(getStructuredAgentSessionLaunchFailure(worktree.id, 'codex-drawn')).toEqual(failure)
        expect(
          useAppStore.getState().tabsByWorktree[worktree.id]?.find((tab) => tab.id === drawnTab)
        ).toMatchObject({ customTitle: null, color: null })
        if (!holdDraw) {
          expect(useAppStore.getState().groupsByWorktree[worktree.id]?.[0]?.tabOrder.at(-1)).toBe(
            drawnTab
          )
        }
      } finally {
        watches.restore()
        vi.useRealTimers()
      }
    }
  )
})
