import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SharedBotHostsState,
  SharedBotHostView
} from '../../../../../shared/bots/shared-bot-hosts'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { subscribeRuntimeRpc } from '../../rpc/subscriptions/runtime-rpc-subscribe'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../rpc/testing/runtime-compatibility-test-fixture'
import {
  installSharedBotHostCatalog,
  isSharedBotHostOnceListed,
  readSharedBotHosts,
  readTeamSharingOffered
} from './shared-bot-host-catalog'
import { selectExecutionHostDisplayLabel } from '../display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { useAppStore } from '@/store'
import { resolveNativeChatRuntimeSessionAttachmentOwner } from '@/components/native-chat/attachments/uploads/native-chat-attachment-owner'
import {
  everyUserProjectHidden,
  indexHiddenProjects,
  isRepoHidden,
  isRepoHiddenFromProjects,
  pickerRepos,
  userManagedRepos
} from '../../../../../shared/project/catalog/hidden-projects'
import { buildExecutionHostRegistry } from '../../../../../shared/execution-host/execution-host-registry'
import { followSharedHostsInRepoCatalog } from '@/store/repos/shared-host-repo-catalog'
import { setProjectHidden } from '@/components/sidebar/hidden-projects/set-project-hidden'
import { loadRuntimeHostCatalogs } from '@/store/host-catalog/host-catalog-fence'
import { getRuntimeClientEventEnvironmentIds } from '@/hooks/ipc-events/runtime-events/runtime-environment-subscription-selection'
import { getReachableRuntimeSessionMirrorTargets } from '../../web-session-tabs-sync/subscriptions/runtime-session-mirror-targets'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { revealSharedBotChat } from '@/lib/agent-session/open/shared-bot-chat-open'

const HOST: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'live',
  holds: true,
  held: []
}
const target = { kind: 'environment', environmentId: HOST.environmentId } as const

let uninstall: () => void
const environmentCall = vi.fn()
const environmentSubscribe = vi.fn()
let changed: (state: SharedBotHostsState) => void = () => {}

beforeEach(async () => {
  environmentCall.mockReset()
  environmentSubscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: {
        list: async () => ({ hosts: [HOST], sharing: true }),
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      },
      runtimeEnvironments: { call: environmentCall, subscribe: environmentSubscribe }
    }
  })
  uninstall = installSharedBotHostCatalog()
  await Promise.resolve()
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

it('names a shared agent’s host as its owner’s computer, never by its environment id', async () => {
  await vi.waitFor(() => expect(readSharedBotHosts()).toHaveLength(1))
  const state = useAppStore.getState()
  expect(selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(HOST.environmentId))).toBe(
    'Jinwoo Hong’s computer'
  )
})

// Its calls and streams go through runtimeEnvironments; main routes them (runtime-environment-shared-hosts.test.ts).
describe('a shared agent’s host in the window', () => {
  it('sends calls and streams through runtimeEnvironments, with no channel of its own', async () => {
    environmentCall.mockImplementation(
      async (request: { method: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(request) ?? {
          id: 'x',
          ok: true,
          result: {},
          _meta: { runtimeId: 'r' }
        }
    )
    await callRuntimeRpc(target, 'bots.list', {})
    await subscribeRuntimeRpc(
      target,
      'agentSession.subscribe',
      { sessionId: 's' },
      { onEvent: () => {}, onError: () => {}, onClose: () => {} }
    )
    expect(environmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: HOST.environmentId, method: 'bots.list' })
    )
    expect(environmentSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ selector: HOST.environmentId, method: 'agentSession.subscribe' }),
      expect.any(Object)
    )
  })
})

describe('sharing offered only where the account’s Orca Cloud takes shares', () => {
  it('offers it on a shares answer, and hides every shared agent and offer on an older cloud', () => {
    expect(readTeamSharingOffered()).toBe(true)
    expect(readSharedBotHosts()).toEqual([HOST])
    changed({ hosts: [HOST], sharing: false })
    expect(readTeamSharingOffered()).toBe(false)
    expect(readSharedBotHosts()).toEqual([])
    // Before the cloud first answers, kept shares still list, but nothing new is offered.
    changed({ hosts: [HOST], sharing: null })
    expect(readTeamSharingOffered()).toBe(false)
    expect(readSharedBotHosts()).toEqual([HOST])
  })
})

it('gives a shared agent’s host a pairing revision while it is shared, so its chats take attachments', () => {
  const session = { sessionId: 'chat-1', runtimeEnvironmentId: HOST.environmentId }
  expect(resolveNativeChatRuntimeSessionAttachmentOwner(session)).toEqual({
    kind: 'runtime-session',
    environmentId: HOST.environmentId,
    pairingRevision: 0,
    sessionId: 'chat-1'
  })
  changed({ hosts: [], sharing: true })
  expect(resolveNativeChatRuntimeSessionAttachmentOwner(session)).toEqual({ kind: 'not-ready' })
})

describe('a shared agent’s chats in this window', () => {
  const connected = runtimeEnvironmentStatusFromSnapshot({
    environmentId: HOST.environmentId,
    pairingRevision: 0,
    sequence: 1,
    checkedAt: 1,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only the runtime id.
    status: { runtimeId: 'host-runtime' } as RuntimeStatus,
    verification: 'verified',
    transport: 'ready',
    sharedHost: true
  })

  it('follows its tabs and events like a paired server’s, though no paired-server row lists it', () => {
    const targets = getReachableRuntimeSessionMirrorTargets({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map([[HOST.environmentId, connected]]),
      projectGroups: [
        {
          id: 'bots',
          connectionId: null,
          executionHostId: toRuntimeExecutionHostId(HOST.environmentId)
        }
      ]
    })
    expect(targets).toEqual([
      expect.objectContaining({ environmentId: HOST.environmentId, pairingRevision: 0 })
    ])
    expect(
      getRuntimeClientEventEnvironmentIds({
        runtimeEnvironments: [],
        settings: null,
        sshStateByEnvironment: new Map(),
        runtimeStatusByEnvironmentId: new Map([[HOST.environmentId, connected]])
      })
    ).toEqual([HOST.environmentId])
  })

  it('opens a chat its host runs in the background by revealing it, never by activating a host tab', async () => {
    environmentCall.mockImplementation(
      async (request: { method: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(request) ?? {
          id: 'x',
          ok: true,
          result:
            request.method === 'orchestration.partyLocation'
              ? { location: { kind: 'chat', sessionId: 'chat-1', worktreeId: 'home' } }
              : { ok: true, sessionId: 'chat-1', workspaceId: 'home', agent: 'claude' },
          _meta: { runtimeId: 'r' }
        }
    )
    expect(
      revealSharedBotChat(
        { hostId: toRuntimeExecutionHostId(HOST.environmentId) },
        'home',
        'chat-1'
      )
    ).toBe(true)
    await vi.waitFor(() =>
      expect(environmentCall).toHaveBeenCalledWith(
        // For this window alone, as the host requires of a teammate.
        expect.objectContaining({
          selector: HOST.environmentId,
          method: 'agentSession.reveal',
          params: { sessionId: 'chat-1', navigation: 'caller' }
        })
      )
    )
    expect(environmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.activate' })
    )
  })

  it('keeps its host’s repos out of every Projects list and the user’s own settings, while the share lasts', async () => {
    const shared = {
      id: 'repo-1',
      hiddenAt: undefined,
      connectionId: null,
      executionHostId: toRuntimeExecutionHostId(HOST.environmentId)
    }
    const local = { ...shared, id: 'repo-2', executionHostId: 'local' as const }
    const repos = [shared, local]
    // The one selector: on a shared host, not by the user's own Hide toggle.
    expect(isRepoHiddenFromProjects(shared)).toBe(true)
    expect(isRepoHidden(shared)).toBe(false)
    expect(isRepoHiddenFromProjects(local)).toBe(false)
    // Projects lists and pickers read it.
    const hidden = indexHiddenProjects(repos, 'local')
    expect(hidden.isRowHidden({ repoId: 'repo-1', hostId: shared.executionHostId })).toBe(true)
    expect(hidden.isRowHidden({ repoId: 'repo-2', hostId: 'local' })).toBe(false)
    expect(pickerRepos(repos)).toEqual([local])
    // Settings lists and pickers: the repos this user manages.
    expect(userManagedRepos(repos)).toEqual([local])
    // Hide/Show writes only the user's own copy of a project both hosts have, and says it worked.
    const updateRepo = vi.fn(async () => true)
    useAppStore.setState({ updateRepo })
    const both = { ...shared, executionHostId: 'local' as const }
    await expect(setProjectHidden([shared, both], true, 'proj')).resolves.toBe(true)
    expect(updateRepo).toHaveBeenCalledTimes(1)
    expect(updateRepo).toHaveBeenCalledWith('repo-1', expect.anything(), { hostId: 'local' })
    // No "every project is hidden" for a user with none of their own.
    expect(everyUserProjectHidden([shared])).toBe(false)
    // Nor is the host one of this user's hosts.
    expect(
      buildExecutionHostRegistry({
        repos,
        settings: null,
        runtimeStatusByEnvironmentId: new Map([
          [
            HOST.environmentId,
            runtimeEnvironmentStatusFromSnapshot({
              environmentId: HOST.environmentId,
              pairingRevision: 0,
              sequence: 1,
              checkedAt: 1,
              status: null,
              verification: 'checking',
              transport: 'ready',
              sharedHost: true
            })
          ]
        ])
      }).map((host) => host.id)
    ).toEqual(['local'])
  })
})

it('lists its home with every host’s folders even when that load starts before its shares arrive', async () => {
  uninstall()
  let answer: (state: SharedBotHostsState) => void = () => {}
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: {
        list: () => new Promise<SharedBotHostsState>((resolve) => (answer = resolve)),
        onChanged: () => () => {}
      },
      runtimeEnvironments: { list: async () => [] }
    }
  })
  uninstall = installSharedBotHostCatalog()
  const loaded: string[] = []
  let listed: readonly string[] = []
  const loading = loadRuntimeHostCatalogs(
    useAppStore.getState,
    'folder-workspaces',
    async (environment) => void loaded.push(environment.environmentId),
    () => true,
    (ids) => (listed = ids)
  )
  // Main answers after the paired-server list does.
  await new Promise((resolve) => setTimeout(resolve, 0))
  answer({ hosts: [HOST], sharing: true })
  await loading
  // Listed, so a restored chat on its home keeps its owner.
  expect(listed).toEqual([HOST.environmentId])
  expect(loaded).toEqual([HOST.environmentId])
})

it('drops an ended share’s repos where the share ends, and republishes the catalog only when the shares change', () => {
  uninstall()
  let push: (state: SharedBotHostsState) => void = () => {}
  vi.stubGlobal('window', {
    api: {
      sharedBotHosts: {
        list: () => new Promise<SharedBotHostsState>(() => {}),
        onChanged: (listener: typeof push) => ((push = listener), () => {})
      }
    }
  })
  uninstall = installSharedBotHostCatalog(followSharedHostsInRepoCatalog(useAppStore))
  push({ hosts: [HOST], sharing: true })
  const shared = {
    id: 'repo-1',
    path: '/proj',
    displayName: 'proj',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: null,
    executionHostId: toRuntimeExecutionHostId(HOST.environmentId)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the purge reads ids and hosts.
  useAppStore.setState({ repos: [shared] as never })
  const before = useAppStore.getState().repos
  // A link-state change alone leaves the catalog as it was.
  push({ hosts: [{ ...HOST, link: 'offline' }], sharing: true })
  expect(useAppStore.getState().repos).toBe(before)
  // A share arriving republishes it, so every reader keyed on it re-reads which hosts are kept out.
  push({ hosts: [HOST, { ...HOST, environmentId: 'env-2', shareId: 'share-2' }], sharing: true })
  expect(useAppStore.getState().repos).not.toBe(before)
  expect(isRepoHiddenFromProjects(shared)).toBe(true)
  push({ hosts: [HOST], sharing: true })
  // The share ends: its host's repos go, so nothing of it reaches Projects or settings.
  push({ hosts: [], sharing: true })
  expect(useAppStore.getState().repos).toEqual([])
})

describe('whether a host is a shared agent’s, once main has listed them', () => {
  it('waits for main’s answer, and never takes a failed read for "not shared"', async () => {
    uninstall()
    let fail: (error: Error) => void = () => {}
    window.api.sharedBotHosts.list = () =>
      new Promise<SharedBotHostsState>((_resolve, reject) => (fail = reject))
    uninstall = installSharedBotHostCatalog()
    let answer: boolean | undefined
    void isSharedBotHostOnceListed(HOST.environmentId).then((shared) => (answer = shared))

    fail(new Error('main is busy'))
    // A zero-delay yield: an answer read from no list would have settled by now.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(answer).toBeUndefined()

    changed({ hosts: [HOST], sharing: true })
    await vi.waitFor(() => expect(answer).toBe(true))
    await expect(isSharedBotHostOnceListed('paired-env')).resolves.toBe(false)
  })
})
