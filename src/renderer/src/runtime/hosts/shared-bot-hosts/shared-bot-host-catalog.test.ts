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
  noteSharedBotHostListing,
  readSharedBotHosts,
  readTeamSharingOffered
} from './shared-bot-host-catalog'
import { readRuntimeDirectory } from '../../files/reads/runtime-directory-read'
import { runtimeFileWorktreeSelector } from '../../files/runtime-file-routing'
import {
  getFileExplorerOperationOwnerFromState,
  type FileExplorerOwnerState
} from '@/components/right-sidebar/file-explorer/navigation/file-explorer-operation-owner'
import { selectExecutionHostDisplayLabel } from '../display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { useAppStore } from '@/store'
import { resolveNativeChatRuntimeSessionAttachmentOwner } from '@/components/native-chat/attachments/uploads/native-chat-attachment-owner'

const HOST: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'live',
  holds: true,
  held: []
}
const target = { kind: 'environment', environmentId: HOST.environmentId } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a shared home resolves before any workspace row is read.
const NO_WORKSPACES = {} as FileExplorerOwnerState

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

describe('Files in this computer’s home of a shared agent', () => {
  const home = 'folder:home-1'
  const context = { target, worktreeId: home, worktreePath: '/local/shared-agents/share-1' }

  it('reads the agent’s home folder on its host, by the host’s own key, read-only', async () => {
    environmentCall.mockImplementation(
      async (request: { method: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(request) ?? {
          id: 'x',
          ok: true,
          result: [],
          _meta: { runtimeId: 'r' }
        }
    )
    await vi.waitFor(() => expect(readSharedBotHosts()).toHaveLength(1))
    // Before the host lists the agent, nothing names its folder there: Files shows nothing.
    expect(getFileExplorerOperationOwnerFromState(NO_WORKSPACES, home)).toEqual({
      kind: 'unresolved'
    })

    noteSharedBotHostListing(toRuntimeExecutionHostId(HOST.environmentId), [
      { id: HOST.botId, folderWorkspaceId: 'host-home' }
    ])
    expect(getFileExplorerOperationOwnerFromState(NO_WORKSPACES, home)).toEqual({
      kind: 'runtime',
      environmentId: HOST.environmentId,
      executionHostId: toRuntimeExecutionHostId(HOST.environmentId),
      readOnly: true
    })
    await readRuntimeDirectory(context, '/local/shared-agents/share-1/notes')
    expect(environmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: HOST.environmentId,
        method: 'files.readDir',
        params: { worktree: 'id:folder:host-home', relativePath: 'notes' }
      })
    )
    // Any other host is asked by the id this computer knows.
    expect(
      runtimeFileWorktreeSelector({ kind: 'environment', environmentId: 'other-env' }, home)
    ).toBe('id:folder:home-1')
  })
})
