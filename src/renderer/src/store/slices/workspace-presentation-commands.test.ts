import type * as SessionClientModule from '../../runtime/structured-agent-session-client'
import { renameStructuredChatTab } from '../../runtime/structured-chat-rename'
import {
  getStructuredChatTabNames,
  subscribeStructuredChatTabNames
} from '../../runtime/structured-chat-name-observation'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { teardownMissingWorktreeTerminalsBestEffort } from './worktrees/teardown/missing-worktree-terminal-teardown'
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seed, O, D, C1 } from './workspace-presentation-test-fixture'
import { makeOpenFile, makeUnifiedTab, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState, workspaceSourceWrite } from '../workspace-composition'
import { useAppStore } from '../index'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { activateStructuredAgentSessionTab } from '../../lib/agent-session/structured-agent-session-tab-activation'
import { buildPlainCreateTerminalParams } from '../../runtime/web-runtime-plain-terminal-create-params'
import { captureStructuredChatRename } from '../../runtime/structured-chat-rename-action'
import { resolveStructuredChatTabName } from '../../runtime/structured-chat-tab-name'
import { structuredAgentSessionTargetForTab } from '../../runtime/structured-agent-session-owner'
import { mergeListedWorktreeSpellings } from './worktrees/session/worktree-spelling-merge'
import { activateWorkspaceTabPaletteResult } from '../../lib/workspace-tab-palette-activation'
import { getActiveTabNavOrder } from '../../components/tab-bar/group-tab-order'
import { OrcaRuntimeService } from '../../../../main/runtime/orca-runtime'
import { revealDashboardAgent } from '../../components/dashboard/reveal-dashboard-agent'
import { activateRetainedAgentRow } from '../../components/sidebar/activate-retained-agent-row'
import { activateStructuredAgentSessionTabOnOwner } from '../../lib/agent-session/structured-agent-session-tab-activation'
vi.mock('../../../../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../../main/ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue({}),
  runtimeEnvironmentSupportsCapability: vi.fn().mockResolvedValue(false)
}))
const names = vi.hoisted(() => ({
  value: new Map([['chat1', { conversationName: 'Host conversation name' }]]),
  listeners: new Set<() => void>()
}))
vi.mock('../../runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: vi.fn(() => ({
    getNamingSnapshot: () => names.value,
    subscribe: (listener: () => void) => {
      names.listeners.add(listener)
      return () => names.listeners.delete(listener)
    },
    activate: () => () => {}
  }))
}))
vi.mock('../../runtime/structured-agent-session-client', async (original) => ({
  ...(await original<typeof SessionClientModule>()),
  supportsStructuredAgentSessionRename: vi.fn(async () => true)
}))
createStoreSessionMockApi()
afterEach(() => vi.restoreAllMocks())
function recoveredEditor() {
  const store = seed()
  const raw = rawWorkspaceState(store.getState())
  const file = makeOpenFile({ id: 'dirty-file', worktreeId: O, isDirty: true })
  const tab = makeUnifiedTab({
    id: 'editor-view',
    entityId: file.id,
    worktreeId: O,
    groupId: 'left',
    contentType: 'editor'
  })
  store.setState(
    workspaceSourceWrite(
      {
        openFiles: [file],
        editorDrafts: { [file.id]: 'unsaved draft' },
        unifiedTabsByWorktree: {
          ...raw.unifiedTabsByWorktree,
          [O]: [...raw.unifiedTabsByWorktree[O], tab]
        }
      },
      { sources: [O] }
    )
  )
  return store
}
describe('PR36538 independent consumer probes', () => {
  it('includes recovered editor in ordinary keyboard navigation', () => {
    const store = recoveredEditor()
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === 'editor-view')).toBe(
      true
    )
    expect(
      getActiveTabNavOrder(store.getState(), D).some((tab) => tab.tabId === 'editor-view')
    ).toBe(true)
  })
  it('keeps recovered dirty editor after the ordinary mount/activation reconciliation', () => {
    const store = recoveredEditor()
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === 'editor-view')).toBe(
      true
    )
    store.getState().reconcileWorktreeTabModel(D)
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === 'editor-view')).toBe(
      true
    )
  })
})

it('routes a recovered native chat activation to its genuine source selector', () => {
  const store = seed()
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  vi.mocked(callRuntimeRpc).mockClear()
  expect(
    activateStructuredAgentSessionTab({ worktreeId: D, tabId: 'structured-agent-session-chat1' })
  ).toBe(true)
  expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.activate', {
    worktree: `id:${O}`,
    tabId: 'agent-session:chat1'
  })
  vi.restoreAllMocks()
})
it.each(['local', 'runtime:box'] as const)(
  'reaches the actual %s host lookup from click, cycle, retained row and dashboard',
  async (hostId) => {
    const store = seed(hostId)
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const runtime = new OrcaRuntimeService(null)
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: O,
      sessionId: 'chat1',
      agent: 'codex',
      activate: false
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: D,
      sessionId: 'chat2',
      agent: 'claude',
      activate: false
    })
    const replies: ReturnType<typeof runtime.activateMobileSessionTab>[] = []
    vi.mocked(callRuntimeRpc).mockImplementation(async (target, method, params) => {
      if (method !== 'session.tabs.activate') {
        return {}
      }
      expect(target).toEqual(
        hostId === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'box' }
      )
      if (
        !params ||
        typeof params !== 'object' ||
        !('worktree' in params) ||
        typeof params.worktree !== 'string' ||
        !('tabId' in params) ||
        typeof params.tabId !== 'string'
      ) {
        throw new Error('invalid activation')
      }
      const pending = runtime.activateMobileSessionTab(params.worktree, params.tabId, undefined, {
        navigation: 'caller',
        clientNavigationId: 'this-client'
      })
      replies.push(pending)
      return pending
    })
    expect(activateStructuredAgentSessionTab({ worktreeId: D, tabId: C1 })).toBe(true)
    activateStructuredAgentSessionTabOnOwner(D, 'chat1')
    activateRetainedAgentRow(D, C1, `${C1}:11111111-1111-4111-8111-111111111111`)
    expect(
      revealDashboardAgent({
        repoId: 'r',
        worktreeId: O,
        tabId: C1,
        leafId: null,
        executionHostId: hostId
      })
    ).toBe(true)
    expect(replies).toHaveLength(4)
    for (const reply of await Promise.all(replies)) {
      expect(reply).toMatchObject({ worktree: O, activeTabId: 'agent-session:chat1' })
    }
    expect(store.getState().activeWorktreeId).toBe(D)
    expect(store.getState().activeGroupIdByWorktree[D]).toBe('left')
    expect(
      rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D].map((tab) => tab.entityId)
    ).toEqual(['chat2'])
    await expect(
      runtime.activateMobileSessionTab(`id:${D}`, 'agent-session:chat1')
    ).rejects.toThrow('tab_not_found')
    vi.mocked(callRuntimeRpc).mockResolvedValue({})
  }
)
it('does not send a composed-only presentation group as an old-host terminal group', async () => {
  const store = seed('runtime:box')
  const clientGroup = store
    .getState()
    .createEmptySplitGroup(D, 'left', 'right', { activate: false })!
  expect(
    rawWorkspaceState(store.getState()).groupsByWorktree[D].some(
      (group) => group.id === clientGroup
    )
  ).toBe(false)
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const params = await buildPlainCreateTerminalParams('box', {
    worktreeId: D,
    targetGroupId: clientGroup
  })
  expect(
    params.targetGroupId === undefined ||
      rawWorkspaceState(store.getState()).groupsByWorktree[D].some(
        (group) => group.id === params.targetGroupId
      )
  ).toBe(true)
})

it('reads the real conversation name using the retained SSH runtime transport', () => {
  const store = seed('ssh:target')
  const raw = rawWorkspaceState(store.getState())
  const rows = raw.worktreesByRepo.r.map((row) => ({ ...row, runtimeOwnerEnvironmentId: 'box' }))
  store.setState(
    workspaceSourceWrite({
      worktreesByRepo: { r: rows },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [O]: 'runtime:box', [D]: 'runtime:box' },
      workspacePresentations: {}
    })
  )
  store.setState(
    mergeListedWorktreeSpellings(store.getState(), 'r', 'runtime:box', { worktrees: rows })
  )
  const before = rawWorkspaceState(store.getState())
  store.setState(
    workspaceSourceWrite(
      {
        unifiedTabsByWorktree: {
          ...before.unifiedTabsByWorktree,
          [O]: before.unifiedTabsByWorktree[O].map((tab) => ({
            ...tab,
            executionHostId: 'runtime:box',
            customLabel: undefined
          }))
        }
      },
      { sources: [O] }
    )
  )
  store.getState().setTabCustomLabel(C1, null, { recordInteraction: false })
  const tab = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)!
  expect(structuredAgentSessionTargetForTab(store.getState(), tab)).toEqual({
    kind: 'environment',
    environmentId: 'box'
  })
  expect(
    resolveStructuredChatTabName(
      { ...tab, executionHostId: 'runtime:box', customLabel: undefined },
      store.getState()
    ).savedName
  ).toBe('Host conversation name')
  expect(resolveStructuredChatTabName(tab, store.getState()).savedName).toBe(
    'Host conversation name'
  )
})

it('activates a recovered editor from the existing workspace palette address', () => {
  const store = recoveredEditor()
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const result = activateWorkspaceTabPaletteResult({
    contentType: 'editor',
    entityId: 'dirty-file',
    groupId: 'left',
    tabId: 'editor-view',
    worktreeId: D
  })
  vi.restoreAllMocks()
  expect(result).toEqual({ status: 'activated' })
})

it('keeps a recovered SSH chat rename current on its valid runtime transport', () => {
  const store = seed('ssh:target')
  const raw = rawWorkspaceState(store.getState())
  const rows = raw.worktreesByRepo.r.map((row) => ({ ...row, runtimeOwnerEnvironmentId: 'box' }))
  store.setState(
    workspaceSourceWrite({
      worktreesByRepo: { r: rows },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [O]: 'runtime:box', [D]: 'runtime:box' },
      workspacePresentations: {}
    })
  )
  store.setState(
    mergeListedWorktreeSpellings(store.getState(), 'r', 'runtime:box', { worktrees: rows })
  )
  const before = rawWorkspaceState(store.getState())
  store.setState(
    workspaceSourceWrite(
      {
        unifiedTabsByWorktree: {
          ...before.unifiedTabsByWorktree,
          [O]: before.unifiedTabsByWorktree[O].map((tab) => ({
            ...tab,
            executionHostId: 'runtime:box',
            customLabel: undefined
          }))
        }
      },
      { sources: [O] }
    )
  )
  store.getState().setTabCustomLabel(C1, null, { recordInteraction: false })
  const control = seed('runtime:box')
  const controlTab = control.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)!
  expect(captureStructuredChatRename(control.getState, controlTab).current()).toBe(true)
  const tab = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)!
  const action = captureStructuredChatRename(store.getState, tab)
  expect(action.current()).toBe(true)
})

it.each([
  ['r::/srv/cafe\u0301', 'r::/srv/caf\u00e9', true],
  ['r::\\\\wsl$\\Ubuntu\\srv\\App', 'r:://wsl.localhost/ubuntu/srv/app', true],
  ['r::C:\\repo', 'r::c:/REPO', false]
])('sends only genuine omitted-source teardown for %s', async (old, live, missing) => {
  vi.mocked(callRuntimeRpc).mockClear()
  await teardownMissingWorktreeTerminalsBestEffort(
    { kind: 'environment', environmentId: 'box' },
    'r',
    null,
    [old],
    makeDetectedResult('r', [makeWorktree({ id: live, repoId: 'r' })], { authoritative: true })
  )
  if (missing) {
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'box' },
      'worktree.teardownMissingTerminals',
      { repo: 'r', worktreeIds: [old], connectionId: null },
      { timeoutMs: 30000 }
    )
  } else {
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  }
})

it('settles a real SSH rename through its transport, publishes the live name and rejects superseded occurrence/intents', async () => {
  const store = seed('ssh:target')
  const raw = rawWorkspaceState(store.getState())
  const rows = raw.worktreesByRepo.r.map((row) => ({ ...row, runtimeOwnerEnvironmentId: 'box' }))
  store.setState({
    worktreesByRepo: { r: rows },
    restoredRuntimeHostIdByWorkspaceSessionKey: { [O]: 'runtime:box', [D]: 'runtime:box' },
    workspacePresentations: {}
  })
  store.setState(
    mergeListedWorktreeSpellings(store.getState(), 'r', 'runtime:box', { worktrees: rows })
  )
  store.getState().setTabCustomLabel(C1, null, { recordInteraction: false })
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  vi.spyOn(useAppStore, 'subscribe').mockImplementation(store.subscribe)
  const notice = vi.fn()
  const stop = subscribeStructuredChatTabNames(notice)
  try {
    const tab = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)!
    expect(getStructuredChatTabNames().get(tab)?.savedName).toBe('Host conversation name')
    vi.mocked(callRuntimeRpc).mockClear()
    await renameStructuredChatTab(store.getState, tab, 'Renamed on host', undefined, vi.fn())
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'box' },
      'agentSession.rename',
      { sessionId: 'chat1', name: 'Renamed on host' }
    )
    names.value = new Map([['chat1', { conversationName: 'Renamed on host' }]])
    names.listeners.forEach((listener) => listener())
    expect(notice).toHaveBeenCalled()
    expect(
      [...getStructuredChatTabNames().values()].find((value) => value.sessionId === 'chat1')
        ?.savedName
    ).toBe('Renamed on host')
    const first = captureStructuredChatRename(store.getState, tab)
    const second = captureStructuredChatRename(store.getState, tab)
    expect(first.current()).toBe(false)
    expect(second.current()).toBe(true)
    store.setState((raw) => ({
      unifiedTabsByWorktree: {
        ...raw.unifiedTabsByWorktree,
        [O]: raw.unifiedTabsByWorktree[O].map((entry) => ({
          ...entry,
          createdAt: entry.createdAt + 1
        }))
      }
    }))
    expect(second.current()).toBe(false)
    first.finish()
    second.finish()
  } finally {
    stop()
    names.value = new Map([['chat1', { conversationName: 'Host conversation name' }]])
  }
})
