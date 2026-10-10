// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type { AgentMessageSource } from '../../../../shared/agent-session-message-source'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const transport = vi.hoisted(() => ({
  bridge: vi.fn(),
  subscribe: vi.fn(),
  focusRenderer: vi.fn(() => false),
  subscriptions: new Map<string, (event: AgentSessionStatusEvent) => void>(),
  unsupported: false,
  olderLookup: false
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  ...moduleFactories.structuredAgentSessionClient(),
  subscribeStructuredAgentSessionStatus: transport.subscribe
}))
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => ({
    settings: null,
    worktreeId: 'shared-workspace',
    worktreePath: '/repo'
  })
}))
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('./NativeChatPaneFileDropSurface', () => ({
  NativeChatPaneFileDropSurface: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../tab-group/RetainedPaneHost', () => ({
  RetainedPaneHost: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  focusRendererTerminalHandle: transport.focusRenderer
}))

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

const WORKSPACE = 'shared-workspace'
const ROOT = testOrcaSessionId('root-chat')
const initial = useAppStore.getInitialState()
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())

function tab(id: string, sessionId: string, name: string, host: 'local' | 'runtime:server-1'): Tab {
  return {
    id,
    entityId: sessionId,
    customLabel: name,
    executionHostId: host,
    worktreeId: WORKSPACE,
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Claude Chat',
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function source(terminal = false): AgentMessageSource {
  const address = terminal ? 'term-sender' : `orca_session_id:${ROOT}`
  return {
    kind: 'agent',
    senders: [
      {
        party: {
          address,
          terminalHandle: terminal ? address : null,
          orcaSessionId: terminal ? null : ROOT
        },
        name: 'Recorded sender'
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r1',
      dispatchId: null,
      messages: [{ messageId: 'mail-1', runId: 'r1', from: address }]
    }
  }
}
function seed(duplicate = false, terminal = false): void {
  const from = source(terminal)
  mocks.messages = [
    {
      id: 'mail',
      role: 'user',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Agent mail' }],
      from
    }
  ]
  mocks.queuedCards = [
    { messageId: 'queued', position: 1, text: 'Agent mail', state: 'waiting', hold: 'turn', from }
  ]
  useAppStore.setState(
    {
      ...initial,
      activeWorktreeId: WORKSPACE,
      activeWorkspaceExecutionHostId: 'local',
      focusGroup: vi.fn(),
      activateTab: vi.fn(),
      setActiveTabType: vi.fn(),
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          {
            ...tab('recipient', 'recipient-chat', 'Recipient', 'runtime:server-1'),
            agentSessionAgent: 'claude'
          },
          tab('remote-sender', ROOT, 'Remote rename', 'runtime:server-1'),
          tab('local-sender', duplicate ? ROOT : 'local-chat', 'Wrong local name', 'local')
        ]
      },
      groupsByWorktree: {
        [WORKSPACE]: [
          { id: 'group', worktreeId: WORKSPACE, activeTabId: 'recipient', tabOrder: ['recipient'] }
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'group' }
    },
    true
  )
}
async function mount(): Promise<ReturnType<typeof render>> {
  let view: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <TooltipProvider>
        <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKSPACE} isWorktreeActive />
      </TooltipProvider>
    )
  })
  return view!
}
function publish(host: string, sessionId: string = ROOT): void {
  transport.subscriptions.get(host)?.({
    type: 'snapshot',
    sessions: [
      {
        sessionId,
        workspaceId: WORKSPACE,
        agent: 'claude',
        status: null,
        latestPrompt: '',
        updatedAt: 1
      }
    ]
  })
}

beforeEach(() => {
  resetStructuredSessionMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  transport.subscriptions.clear()
  transport.subscribe.mockReset()
  transport.focusRenderer.mockClear()
  transport.unsupported = false
  transport.olderLookup = false
  transport.subscribe.mockImplementation(
    async (target: RuntimeClientTarget, emit: (event: AgentSessionStatusEvent) => void) => {
      const host = target.kind === 'local' ? 'local' : target.environmentId
      transport.subscriptions.set(host, emit)
      return { unsubscribe: vi.fn(() => transport.subscriptions.delete(host)) }
    }
  )
  transport.bridge.mockReset()
  transport.bridge.mockImplementation(
    async ({ method, params }: { method: string; params?: { address?: string } }) => {
      if (method === 'orchestration.partyLocation' && transport.olderLookup) {
        return {
          id: 'reply',
          ok: false,
          error: { code: 'method_not_found', message: 'older host' },
          _meta: { runtimeId: 'remote' }
        }
      }
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: transport.unsupported
                ? []
                : [AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY]
            }
          : method === 'orchestration.partyLocation'
            ? {
                location:
                  params?.address === 'term-sender'
                    ? { kind: 'terminal', handle: 'term-current' }
                    : { kind: 'chat', sessionId: ROOT, worktreeId: WORKSPACE }
              }
            : { ok: true }
      return { id: 'reply', ok: true, result, _meta: { runtimeId: 'remote' } }
    }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      runtime: { call: transport.bridge },
      runtimeEnvironments: { call: transport.bridge }
    }
  })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initial, true)
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it.each([false, true])(
  'uses the stamped recipient host through queue/transcript names, renames and chat clicks (duplicate IDs %s)',
  async (duplicate) => {
    seed(duplicate)
    const stopLocal = getStructuredAgentSessionStatusFeed({ kind: 'local' }).activate()
    await mount()
    act(() => {
      publish('local', duplicate ? ROOT : 'local-chat')
      publish('server-1')
    })
    expect(screen.getAllByRole('button', { name: 'Remote rename' })).toHaveLength(2)
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [WORKSPACE]: useAppStore
            .getState()
            .unifiedTabsByWorktree[WORKSPACE]!.map((t) =>
              t.id === 'remote-sender' ? { ...t, customLabel: 'Updated remote rename' } : t
            )
        }
      })
    )
    const links = screen.getAllByRole('button', { name: 'Updated remote rename' })
    for (const link of links) {
      await act(async () => fireEvent.click(link))
      expect(transport.bridge).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'server-1', method: 'orchestration.partyLocation' })
      )
      expect(transport.bridge).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'server-1', method: 'session.tabs.activate' })
      )
      expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
        worktreeId: WORKSPACE
      })
    }
    stopLocal()
  }
)

it('keeps recorded CLI labels and focuses the exact remote pane from both surfaces', async () => {
  seed(false, true)
  await mount()
  for (const link of screen.getAllByRole('button', { name: 'Recorded sender' })) {
    await act(async () => fireEvent.click(link))
    expect(transport.focusRenderer).toHaveBeenLastCalledWith('term-current', 'server-1')
    expect(transport.bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'server-1',
        method: 'terminal.focus',
        params: { terminal: 'term-current', navigation: 'host' }
      })
    )
  }
})

it('keeps older-host direct-root names and both clicks on the stamped host when the workspace is local', async () => {
  seed()
  transport.unsupported = true
  transport.olderLookup = true
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        useAppStore.getState().unifiedTabsByWorktree[WORKSPACE]![0]!,
        tab('wrong-local', ROOT, 'Wrong local name', 'local'),
        tab('remote-sender', ROOT, 'Legacy remote rename', 'runtime:server-1')
      ]
    }
  })
  await mount()
  for (const link of screen.getAllByRole('button', { name: 'Legacy remote rename' })) {
    await act(async () => fireEvent.click(link))
    expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
      worktreeId: WORKSPACE
    })
    expect(transport.bridge).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'server-1', method: 'session.tabs.activate' })
    )
  }
})
