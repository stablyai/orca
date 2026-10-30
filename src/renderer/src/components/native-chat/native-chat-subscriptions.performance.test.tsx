// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { NativeChatSkillDiscovery } from './use-native-chat-skills'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import {
  agentSessionTabFixture,
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace as workspace,
  terminalTabFixture
} from './native-chat-workspace-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import type * as StructuredClient from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { useNativeChatHandOff, type NativeChatHandOff } from './use-native-chat-hand-off'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
const handOffTransport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredClient>()),
  subscribeStructuredAgentSessionStatus: handOffTransport.subscribe,
  supportsStructuredAgentSessionContinuationContext: vi.fn(async () => false)
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: ({
    request
  }: {
    request: AgentSessionContinuationRequest | null
  }) => <output>{request?.source.sourceTitle}</output>
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatSkillDiscovery: vi.fn() }))

import {
  resetNativeChatSkillDiscoveryCacheForTests,
  useNativeChatSkills
} from './use-native-chat-skills'

type Work = {
  terminalRows: number
  unifiedRows: number
  terminalMapEnumerations: number
  unifiedMapEnumerations: number
  terminalWorkspaceReads: number
  unifiedWorkspaceReads: number
}

function emptyWork(): Work {
  return {
    terminalRows: 0,
    unifiedRows: 0,
    terminalMapEnumerations: 0,
    unifiedMapEnumerations: 0,
    terminalWorkspaceReads: 0,
    unifiedWorkspaceReads: 0
  }
}

function countRow<T extends { id: string }>(row: T, count: () => void): T {
  const id = row.id
  Object.defineProperty(row, 'id', {
    enumerable: true,
    get() {
      count()
      return id
    }
  })
  return row
}

function corpus(scale: number, dense = false) {
  const mounted = 57 * scale
  const workspaces = dense ? 1 : 100 * scale
  const work = emptyWork()
  const fixture = nativeChatFanoutFixture(mounted, workspaces, 1)
  const { tabsByWorktree, unifiedTabsByWorktree } = fixture
  const chatIds = Object.values(unifiedTabsByWorktree).flatMap((rows) => rows.map((row) => row.id))
  for (const row of Object.values(tabsByWorktree).flat()) {
    countRow(row, () => work.terminalRows++)
  }
  for (const row of Object.values(unifiedTabsByWorktree).flat()) {
    countRow(row, () => work.unifiedRows++)
  }

  function terminalMap(map: AppState['tabsByWorktree']) {
    return new Proxy(map, {
      get(target, key) {
        if (typeof key === 'string' && Object.hasOwn(target, key)) {
          work.terminalWorkspaceReads += 1
        }
        return typeof key === 'string' ? target[key] : undefined
      },
      ownKeys(target) {
        work.terminalMapEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
  }
  function unifiedMap(map: AppState['unifiedTabsByWorktree']) {
    return new Proxy(map, {
      get(target, key) {
        if (typeof key === 'string' && Object.hasOwn(target, key)) {
          work.unifiedWorkspaceReads += 1
        }
        return typeof key === 'string' ? target[key] : undefined
      },
      ownKeys(target) {
        work.unifiedMapEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
  }

  useAppStore.setState({
    ...useAppStore.getInitialState(),
    ...fixture,
    activeRepoId: null,
    activeWorktreeId: workspace(0),
    activeWorkspaceExecutionHostId: 'local',
    repos: [],
    settings: getDefaultSettings('/test-home'),
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    projectGroups: [],
    projects: [],
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    tabsByWorktree: terminalMap(tabsByWorktree),
    unifiedTabsByWorktree: unifiedMap(unifiedTabsByWorktree)
  })

  return {
    mounted,
    chatIds,
    workspaces,
    work,
    reset: () => Object.assign(work, emptyWork()),
    renameUnrelated(kind: 'terminal' | 'unified', version: number) {
      const owner = workspace(workspaces - 1)
      const current = useAppStore.getState()
      // Prepare the writer's immutable replacement before counting subscriber work.
      const patch =
        kind === 'terminal'
          ? {
              tabsByWorktree: terminalMap({
                ...current.tabsByWorktree,
                [owner]: [
                  countRow(
                    terminalTabFixture(`terminal-${workspaces - 1}-0`, owner, {
                      title: `${version}`
                    }),
                    () => work.terminalRows++
                  )
                ]
              })
            }
          : {
              unifiedTabsByWorktree: unifiedMap({
                ...current.unifiedTabsByWorktree,
                [owner]: [
                  countRow(
                    agentSessionTabFixture('unmounted-chat', owner, {
                      label: `${version}`
                    }),
                    () => work.unifiedRows++
                  )
                ]
              })
            }
      Object.assign(work, emptyWork())
      act(() => useAppStore.setState(patch))
      return { ...work }
    },
    replaceOwnList(rename: boolean) {
      const current = useAppStore.getState()
      const list = current.unifiedTabsByWorktree[workspace(0)]
      const replacement = unifiedMap({
        ...current.unifiedTabsByWorktree,
        [workspace(0)]: rename
          ? [countRow({ ...list[0], label: 'Renamed' }, () => work.unifiedRows++), ...list.slice(1)]
          : [...list]
      })
      Object.assign(work, emptyWork())
      act(() => useAppStore.setState({ unifiedTabsByWorktree: replacement }))
      return { ...work }
    },
    moveLastChat() {
      const source = workspace(mounted - 1)
      const destination = workspace(workspaces - 2)
      const current = useAppStore.getState()
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: unifiedMap({
            ...current.unifiedTabsByWorktree,
            [source]: [],
            [destination]: [agentSessionTabFixture(`chat-${mounted - 1}`, destination)]
          })
        })
      )
      return destination
    }
  }
}

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  resetNativeChatSkillDiscoveryCacheForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  handOffTransport.subscribe.mockReset()
  rpc.mockReset()
})

function measureImageSubscriptions(scale: number) {
  const data = corpus(scale)
  const contexts = new Map<string, NativeChatImageRuntimeContext>()
  let renders = 0
  function Probe({ chatId }: { chatId: string }) {
    contexts.set(chatId, useNativeChatImageRuntimeContext(chatId))
    renders += 1
    return null
  }
  const view = render(data.chatIds.map((chatId) => <Probe key={chatId} chatId={chatId} />))
  expect(contexts.size).toBe(data.mounted)
  for (let index = 0; index < data.mounted; index += 1) {
    expect(contexts.get(`chat-${index}`)?.worktreePath).toBe(`/repo/${index}`)
  }
  const baseline = renders
  const rounds: Work[] = []
  // Separate writes ensure a warm selector cache cannot hide a map invalidation.
  for (let version = 0; version < 3; version += 1) {
    rounds.push(data.renameUnrelated('terminal', version))
    rounds.push(data.renameUnrelated('unified', version))
  }
  expect(renders - baseline).toBe(0)

  data.reset()
  act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
  expect(data.work).toEqual(emptyWork())
  expect(renders - baseline).toBe(0)

  const destination = data.moveLastChat()
  expect(contexts.get(`chat-${data.mounted - 1}`)).toMatchObject({
    worktreeId: destination,
    worktreePath: `/repo/${data.workspaces - 2}`,
    target: { kind: 'local' }
  })
  expect(renders - baseline).toBe(1)
  view.unmount()
  return {
    mounted: data.mounted,
    workspaces: data.workspaces,
    canonicalRows: { terminal: data.workspaces, unified: data.mounted + 1 },
    unrelatedRenders: 0,
    rounds
  }
}

describe('native chat store subscription performance', () => {
  it('keeps hand-off tab scans and unrelated renders at zero at N and 10N while titles stay live', async () => {
    for (const scale of [1, 10]) {
      const data = corpus(scale, true)
      const emits = new Map<string, (event: AgentSessionStatusEvent) => void>()
      handOffTransport.subscribe.mockImplementation(
        async (target: RuntimeClientTarget, emit: (event: AgentSessionStatusEvent) => void) => {
          emits.set(target.kind === 'local' ? 'local' : target.environmentId, emit)
          return { unsubscribe: vi.fn() }
        }
      )
      const controls = new Map<string, NativeChatHandOff>()
      const renders = new Map<string, number>()
      function Probe({ chatId, index }: { chatId: string; index: number }) {
        const handOff = useNativeChatHandOff({
          pane: {
            tabId: chatId,
            sessionId: `session-${index}`,
            groupId: 'group',
            agent: 'codex',
            target: { kind: 'local' },
            isVisible: true
          },
          directory: {
            worktreeId: workspace(0),
            worktreePath: '/repo/0',
            runtimeEnvironmentId: null
          },
          epoch: 'epoch',
          messages: [
            {
              id: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Saved context' }],
              timestamp: 1,
              source: 'transcript'
            }
          ],
          focusComposer: () => undefined
        })
        controls.set(chatId, handOff)
        renders.set(chatId, (renders.get(chatId) ?? 0) + 1)
        return handOff.dialog
      }
      const view = render(
        data.chatIds.map((chatId, index) => <Probe key={chatId} chatId={chatId} index={index} />)
      )
      const otherFeed = getStructuredAgentSessionStatusFeed({
        kind: 'environment',
        environmentId: 'other'
      })
      let stopOther: () => void = () => undefined
      await act(async () => {
        stopOther = otherFeed.activate()
      })
      const baseline = new Map(renders)
      const publishName = (host: string, sessionId: string, conversationName: string) => {
        const emit = emits.get(host)
        if (!emit) {
          throw new Error(`Missing ${host} status transport`)
        }
        act(() =>
          emit({
            type: 'snapshot',
            sessions: [],
            conversationNames: [{ sessionId, conversationName }]
          })
        )
      }
      const operations: Work[] = []
      for (let tick = 0; tick < 3; tick++) {
        data.reset()
        act(() => useAppStore.setState({ lastTerminalInputAtByPaneKey: { other: tick } }))
        operations.push({ ...data.work })
        expect(renders).toEqual(baseline)
        data.reset()
        publishName('other', 'session-0', `Other host ${tick}`)
        operations.push({ ...data.work })
        expect(renders).toEqual(baseline)
        data.reset()
        publishName('local', 'unmounted-session', `Unrelated name ${tick}`)
        operations.push({ ...data.work })
        expect(renders).toEqual(baseline)
      }
      for (const work of operations) {
        expect(work.unifiedRows).toBe(0)
        expect(work.terminalRows).toBe(0)
        expect(work.unifiedMapEnumerations).toBe(0)
      }
      const current = useAppStore.getState()
      const rows = current.unifiedTabsByWorktree[workspace(0)]
      const renamed = countRow(
        { ...rows[0], customLabel: null, label: 'Live label' },
        () => data.work.unifiedRows++
      )
      data.reset()
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: {
            ...current.unifiedTabsByWorktree,
            [workspace(0)]: [renamed, ...rows.slice(1)]
          }
        })
      )
      expect(data.work.unifiedRows).toBeLessThanOrEqual(data.mounted)
      expect(renders.get('chat-0')).toBe(baseline.get('chat-0')! + 1)
      for (const chatId of data.chatIds.slice(1)) {
        expect(renders.get(chatId)).toBe(baseline.get(chatId))
      }
      const openTitle = async (title: string) => {
        await act(async () => controls.get('chat-0')!.open())
        expect(view.container.textContent).toBe(title)
        act(() => controls.get('chat-0')!.reset())
      }
      await openTitle('Live label')
      const beforeName = new Map(renders)
      data.reset()
      publishName('local', 'session-0', 'Live saved name')
      expect(data.work.unifiedRows).toBe(0)
      expect(renders.get('chat-0')).toBe(beforeName.get('chat-0')! + 1)
      for (const chatId of data.chatIds.slice(1)) {
        expect(renders.get(chatId)).toBe(beforeName.get(chatId))
      }
      await openTitle('Live saved name')
      console.info(
        'native-chat-handoff-subscription-work',
        JSON.stringify({ mounted: data.mounted, operations })
      )
      view.unmount()
      stopOther()
      resetStructuredAgentSessionStatusFeedsForTests()
    }
  })

  it('does no tab work for closed pickers at N and 10N, then discovers the latest owner on activation', async () => {
    rpc.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    for (const scale of [1, 10]) {
      const pending = Promise.withResolvers<never>()
      rpc.mockReturnValueOnce(pending.promise)
      const data = corpus(scale)
      const lastChatId = `chat-${data.mounted - 1}`
      const snapshots = new Map<string, NativeChatSkillDiscovery>()
      let renders = 0
      function Probe({ chatId, enabled }: { chatId: string; enabled: boolean }) {
        snapshots.set(chatId, useNativeChatSkills('codex', chatId, enabled))
        renders += 1
        return null
      }
      const probes = (enabled: boolean) =>
        data.chatIds.map((chatId) => (
          <Probe key={chatId} chatId={chatId} enabled={enabled && chatId === lastChatId} />
        ))
      const view = render(probes(false))
      const baseline = renders
      for (const kind of ['terminal', 'unified'] as const) {
        expect(data.renameUnrelated(kind, 1)).toEqual(emptyWork())
      }
      const destination = data.moveLastChat()
      expect(renders).toBe(baseline)
      expect(rpc).not.toHaveBeenCalled()

      view.rerender(probes(true))
      expect(snapshots.get(lastChatId)?.status).toBe('loading')
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'local' },
        'skills.discover',
        expect.objectContaining({ cwd: `/repo/${data.workspaces - 2}`, worktreeId: destination }),
        { timeoutMs: 10_000 }
      )
      view.rerender(probes(false))
      const current = useAppStore.getState()
      act(() =>
        useAppStore.setState({
          folderWorkspaces: current.folderWorkspaces.map((folder) =>
            `folder:${folder.id}` === destination
              ? {
                  ...folder,
                  folderPath: '/latest-owner-path',
                  executionHostId: 'runtime:latest' as const
                }
              : folder
          )
        })
      )
      expect(snapshots.get(lastChatId)?.status).toBe('idle')
      view.rerender(probes(true))
      await waitFor(() => expect(snapshots.get(lastChatId)?.status).toBe('ready'))
      expect(rpc).toHaveBeenLastCalledWith(
        { kind: 'environment', environmentId: 'latest' },
        'skills.discover',
        { cwd: '/latest-owner-path', worktreeId: destination },
        { timeoutMs: 10_000 }
      )
      await act(async () => pending.reject(new Error('Old owner request failed')))
      expect(snapshots.get(lastChatId)?.status).toBe('ready')
      view.unmount()
      rpc.mockClear()
      resetNativeChatSkillDiscoveryCacheForTests()
    }
  })

  it('benchmarks image-owner scans separately from renders at N and 10N', () => {
    const results = [1, 10].map(measureImageSubscriptions)
    for (const result of results) {
      for (const [index, work] of result.rounds.entries()) {
        // One shared index build per changed map, never a population scan per mounted chat.
        expect(work.terminalRows).toBeLessThanOrEqual(
          index % 2 === 0 ? result.canonicalRows.terminal : 0
        )
        expect(work.unifiedRows).toBeLessThanOrEqual(
          index % 2 === 1 ? result.canonicalRows.unified : 0
        )
        expect(work.terminalMapEnumerations).toBeLessThanOrEqual(index % 2 === 0 ? 1 : 0)
        expect(work.unifiedMapEnumerations).toBeLessThanOrEqual(index % 2 === 1 ? 1 : 0)
        expect(work.terminalWorkspaceReads).toBeLessThanOrEqual(
          index % 2 === 0 ? result.workspaces : 0
        )
        expect(work.unifiedWorkspaceReads).toBeLessThanOrEqual(
          index % 2 === 1 ? result.workspaces : 0
        )
      }
    }
    console.info('native-chat-subscription-work', JSON.stringify(results))
  })

  it('bounds dense ordinary-workspace image work on mount and own-list rename/replace at N and 10N', () => {
    const results: {
      mounted: number
      mount: Work
      updates: Work[]
      updateRenders: number
    }[] = []
    for (const scale of [1, 10]) {
      const data = corpus(scale, true)
      let renders = 0
      function Probe({ chatId }: { chatId: string }) {
        const context = useNativeChatImageRuntimeContext(chatId)
        expect(context?.worktreePath).toBe('/repo/0')
        renders += 1
        return null
      }
      data.reset()
      const view = render(data.chatIds.map((chatId) => <Probe key={chatId} chatId={chatId} />))
      const mount = { ...data.work }
      // All canonical rows may be indexed once. Private per-hook maps would cost N + N².
      expect(mount.terminalRows).toBeLessThanOrEqual(1)
      expect(mount.unifiedRows).toBeLessThanOrEqual(data.mounted)
      expect(mount.terminalMapEnumerations).toBeLessThanOrEqual(1)
      expect(mount.unifiedMapEnumerations).toBeLessThanOrEqual(1)
      expect(renders).toBe(data.mounted)
      const baseline = renders
      const updates = [data.replaceOwnList(true), data.replaceOwnList(false)]
      for (const work of updates) {
        expect(work.terminalRows).toBe(0)
        expect(work.unifiedRows).toBeLessThanOrEqual(data.mounted)
        expect(work.unifiedMapEnumerations).toBeLessThanOrEqual(1)
        expect(work.unifiedWorkspaceReads).toBeLessThanOrEqual(1)
      }
      expect(renders - baseline).toBe(0)
      results.push({ mounted: data.mounted, mount, updates, updateRenders: renders - baseline })
      view.unmount()
    }
    console.info('native-chat-dense-subscription-work', JSON.stringify(results))
  })
})
