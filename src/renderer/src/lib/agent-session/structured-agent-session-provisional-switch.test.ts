// @vitest-environment happy-dom
import { noteUserWorkspaceSwitch } from '@/lib/workspace-switch-user-act'
import { getDefaultSettings } from '../../../../shared/constants'
import type * as CliChatResumeSourceModule from '@/components/tab-bar/cli-chat-resume-source'
import type * as CliChatResumeTerminalCapture from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import { runConversationSwitch } from '../conversation-surface-switch'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type * as SessionClient from '@/runtime/structured-agent-session-client'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { resetStructuredAgentLaunchRegistryForTests } from './launch/structured-agent-session-launch-registry'
import { clearNativeChatPendingAttachmentsForTests } from '@/components/native-chat/native-chat-pending-attachment-cache'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'

// Terminal→chat through the real host admission and the provisional and layout writers; only the
// host's replies and the source terminal's capture are stood in.

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const rpc = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...rpc,
    callRuntimeRpc: (...args: Parameters<typeof rpc.callRuntimeRpc>) => {
      if (mocks.source.current && args[1] === 'terminal.stopExact') {
        mocks.stopped(args[2])
        return Promise.resolve({ stoppedPtyIds: ['source-pty'], postStopVerified: true })
      }
      return rpc.callRuntimeRpc(...args)
    }
  }
})
vi.mock('@/runtime/structured-agent-session-client', async (original) => {
  const client = await original<typeof SessionClient>()
  return {
    ...client,
    supportsStructuredAgentSessionCreateMessage: (
      ...args: Parameters<typeof client.supportsStructuredAgentSessionCreateMessage>
    ) =>
      mocks.source.current
        ? Promise.resolve(false)
        : client.supportsStructuredAgentSessionCreateMessage(...args),
    callStructuredAgentSession: (...args: Parameters<typeof client.callStructuredAgentSession>) => {
      if (mocks.source.current && args[1] === 'agentSession.createSupport') {
        return mocks.support()
      }
      if (mocks.source.current && args[1] === 'agentSession.create') {
        return mocks.create(args[2])
      }
      return client.callStructuredAgentSession(...args)
    }
  }
})
vi.mock('@/components/tab-bar/cli-chat-resume-source', async (original) => {
  const actual = await original<typeof CliChatResumeSourceModule>()
  return {
    ...actual,
    resolveCliChatResumeSource: (...args: Parameters<typeof actual.resolveCliChatResumeSource>) =>
      mocks.source.current ?? actual.resolveCliChatResumeSource(...args)
  }
})
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', async (original) => {
  const actual = await original<typeof CliChatResumeTerminalCapture>()
  return {
    ...actual,
    captureSourceTerminal: (...args: Parameters<typeof actual.captureSourceTerminal>) =>
      mocks.source.current
        ? Promise.resolve(
            mocks.captured.current
              ? {
                  target: { kind: 'local' },
                  handle: 'source-handle',
                  incarnationId: 'source-incarnation',
                  presentation: { identity: { ptyId: 'source-pty' } }
                }
              : null
          )
        : actual.captureSourceTerminal(...args)
  }
})
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mocks = vi.hoisted(() => {
  function makeSource(): { current: CliChatResumeSource | null } {
    return { current: null }
  }
  return {
    create: vi.fn(),
    support: vi.fn(),
    stopped: vi.fn(),
    source: makeSource(),
    captured: { current: true }
  }
})
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

function terminalRecord(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.source.current = null
  mocks.captured.current = true
  setLocalRuntimeCapabilitiesForTests([])
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  resetStructuredAgentLaunchRegistryForTests()
  clearNativeChatPendingAttachmentsForTests()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => main.close())

async function mainLoadsStoreLayout(): Promise<void> {
  main.close()
  main = await drawTabsFromMain(useAppStore)
}

it.each([
  [false, true],
  [true, true],
  [false, false]
])(
  'strict legacy Stop through real host admission and provisional/layout writers, newer navigation=%s, captured=%s',
  async (navigate, captured) => {
    // A pane with no terminal to capture (its shell exited) stops nothing and opens the chat.
    mocks.captured.current = captured
    const source = useAppStore
      .getState()
      .createUnifiedTab('wt-1', 'terminal', { id: 'source-terminal', entityId: 'source-terminal' })
    const other = useAppStore
      .getState()
      .createUnifiedTab('wt-1', 'agent-session', { entityId: 'D', activate: false })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [terminalRecord(source.id)] },
      terminalLayoutsByTabId: {
        [source.id]: {
          root: { type: 'leaf', leafId: 'leaf' },
          activeLeafId: 'leaf',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf: 'source-pty' }
        }
      }
    })
    await mainLoadsStoreLayout()
    useAppStore.getState().activateTab(source.id)
    useAppStore.getState().setActiveTabType('terminal', 'wt-1')
    mocks.source.current = {
      agent: 'codex',
      executionHostId: 'local',
      workspaceId: 'wt-1',
      tabId: source.id,
      paneKey: `${source.id}:leaf`,
      ptyId: 'source-pty',
      providerSessionId: 'saved-provider'
    }
    const admission = Promise.withResolvers<{ supported: true }>()
    mocks.support.mockReturnValue(admission.promise)
    mocks.create.mockImplementation(
      async (
        params: StructuredAgentSessionCreateParams
      ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> => {
        const sessionId = params.envelope.sessionId
        const cursor = { epoch: 'fixture-epoch', sequence: 0 }
        return {
          ok: true,
          replayed: false,
          fence: 1,
          cursor,
          value: {
            sessionId,
            fence: 1,
            unconfirmedClientMessageIds: [],
            page: {
              sessionId,
              epoch: cursor.epoch,
              direction: 'tail',
              items: [],
              removedItemIds: [],
              submissions: [],
              window: { oldest: null, newest: null, nextCursor: cursor },
              hasOlder: false,
              hasNewer: false
            }
          }
        }
      }
    )
    setLocalRuntimeCapabilitiesForTests([])
    useAppStore.setState((state) => ({
      settings: {
        ...getDefaultSettings('/home/test'),
        ...state.settings
      }
    }))
    const running = runConversationSwitch({
      direction: 'chat',
      ...mocks.source.current,
      source: mocks.source.current
    })
    await vi.waitFor(() => expect(mocks.support).toHaveBeenCalledOnce())
    if (captured) {
      expect(mocks.stopped).toHaveBeenCalledExactlyOnceWith({
        worktree: 'id:wt-1',
        expectedPtyIds: ['source-pty'],
        targetOnly: true,
        keepHistory: true
      })
    } else {
      expect(mocks.stopped).not.toHaveBeenCalled()
    }
    expect(mocks.create).not.toHaveBeenCalled()
    await main.settle()
    if (navigate) {
      noteUserWorkspaceSwitch('wt-1')
      useAppStore.getState().activateTab(other.id)
    }
    admission.resolve({ supported: true })
    await running
    await main.settle()
    const chats = useAppStore
      .getState()
      .unifiedTabsByWorktree['wt-1'].filter(
        (tab) => tab.contentType === 'agent-session' && tab.entityId !== 'D'
      )
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(chats).toHaveLength(1)
    expect(useAppStore.getState().getActiveTab('wt-1')?.id).toBe(navigate ? other.id : chats[0].id)
    expect(mocks.create.mock.calls[0][0].resumeFrom.providerSessionId).toBe('saved-provider')
    expect(mocks.create.mock.calls[0][0].envelope.sessionId).toBe(chats[0].entityId)
  }
)
