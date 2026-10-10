// @vitest-environment happy-dom
import { transport } from './__mocks__/structured-attention-read-surfaces'
import { cleanup } from '@testing-library/react'
import { beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { NotificationSettings } from '../../src/shared/notification-settings-types'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../src/shared/agent-session-wire'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import {
  structuredAgentSessionPaneKey,
  projectStructuredAgentSessionStatusState
} from '../../src/shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../src/main/runtime/runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from '../../src/main/runtime/structured-agent-session-mobile-attention'
import {
  call,
  installStructuredHostStub,
  clearStructuredHostStub,
  STRUCTURED_CLIENT,
  SESSION
} from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import {
  makeUnifiedTab,
  makeTabGroup,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'

import { useAppStore } from '@/store'
import { useAutoAckViewedAgent } from '@/hooks/useAutoAckViewedAgent'
import { useStructuredAgentSessionRead } from '@/components/native-chat/use-structured-agent-session-read'
import { resetStructuredAgentSessionReadOwnersForTests } from '@/components/native-chat/structured-agent-session-read-owner'
import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/structured-agent-session-turn-completion-feed'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

export const WORKSPACE = 'repo1::/tmp/wt'
export const TAB = 'chat'
export const SUBJECT = structuredAgentSessionPaneKey(TAB, SESSION)
export const TARGET = { kind: 'local' } as const
export const REMOTE_TARGET = { kind: 'environment', environmentId: 'relay-host' } as const
export const NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  agentTaskComplete: true,
  terminalBell: true,
  suppressWhenFocused: true,
  customSoundId: 'system',
  customSoundPath: null,
  customSoundVolume: 1,
  mutedNotificationSourceIds: []
}
export const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKSPACE,
  workspaceKind: 'git-worktree'
} as const
export let fixture: {
  directory: string
  controller: RuntimeMobileNotificationController
  events: MobileNotificationEvent[]
  items: AgentJournalRenderItem[]
  sequence: number
  hostFeed: StructuredAgentSessionTurnCompletionFeed
  completion: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
  journal: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
  status: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
  hydrate: (() => void) | undefined
}

export { transport }

function history(): AgentSessionHistoryPage {
  return {
    sessionId: SESSION,
    epoch: 'journal-a',
    direction: 'tail',
    items: [...fixture.items],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'journal-a', sequence: 1 },
      newest: { epoch: 'journal-a', sequence: fixture.sequence },
      nextCursor: { epoch: 'journal-a', sequence: 1 }
    },
    liveCursor: { epoch: 'journal-a', sequence: fixture.sequence },
    hasOlder: false,
    hasNewer: false
  }
}
export function addPrompt(id: string): void {
  fixture.items = [
    ...fixture.items,
    {
      itemId: id,
      revision: 1,
      sequence: ++fixture.sequence,
      observedAt: fixture.sequence,
      body: {
        kind: 'approval',
        title: 'Allow?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
  ]
  fixture.hostFeed.observe(SESSION)
}
export function publishView(): void {
  fixture.journal?.({
    id: 'journal',
    ok: true,
    _meta: { runtimeId: 'attention-host' },
    result: { type: 'snapshot', sessionId: SESSION, page: history(), fence: 1 }
  })
}
/** The host's clock: each journal commit lands one second later. */
export function hostClock(): number {
  return fixture.sequence * 1_000
}
/** The host's status row for this commit, from the same projection its status feed publishes. */
export function publishStatus(): void {
  fixture.status?.({
    id: 'status',
    ok: true,
    _meta: { runtimeId: 'attention-host' },
    result: {
      type: 'status',
      session: {
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        agent: 'claude',
        ...projectStructuredAgentSessionStatusState(fixture.items).summary,
        updatedAt: hostClock()
      }
    }
  })
}
export function ReadSurface({
  viewed,
  target = TARGET
}: {
  viewed: boolean
  target?: RuntimeClientTarget
}): null {
  useStructuredAgentSessionRead({
    sessionId: SESSION,
    target,
    isVisible: true,
    isViewed: viewed
  })
  return null
}
export function AttentionPolicy(): null {
  useAutoAckViewedAgent()
  return null
}
export function readCalls(): number {
  return transport.call.mock.calls.filter(
    ([, method]) => method === 'agentSession.acknowledgeAttention'
  ).length
}
export function dismissIds(): string[] {
  return fixture.events
    .filter((event) => event.type === 'dismiss')
    .map((event) => event.notificationId)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const directory = mkdtempSync(join(tmpdir(), 'orca-renderer-read-'))
  installStructuredHostStub()
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  const events: MobileNotificationEvent[] = []
  controller.onDispatched((event) => events.push(event))
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'user',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Work' }] }
    },
    {
      itemId: 'turn',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
    }
  ]
  const sequence = 2
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionTurnCompletionFeedsForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({ ...NOTIFICATION_SETTINGS, suppressWhenFocused: false }),
    readWorkspaceLabels: () => ({}),
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: () => 42
  })
  const hostFeed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([
      [
        SESSION,
        {
          journal: { cursor: () => ({ epoch: 'journal-a', sequence: fixture.sequence }) },
          params: { location: SCOPE }
        }
      ]
    ]),
    readStatusState: () => projectStructuredAgentSessionStatusState(fixture.items),
    now: hostClock
  })
  fixture = {
    directory,
    controller,
    events,
    items,
    sequence,
    hostFeed,
    completion: undefined,
    journal: undefined,
    status: undefined,
    hydrate: undefined
  }
  fixture.hostFeed.subscribe({
    id: 'mobile-and-renderer',
    includePrompts: true,
    onState: delivery.reconcile,
    emit: (event) => {
      if (event.type !== 'end') {
        delivery.deliver(event, undefined)
        fixture.completion?.({
          id: 'completion',
          ok: true,
          _meta: { runtimeId: 'attention-host' },
          result: event
        })
      }
    }
  })
  fixture.hostFeed.observe(SESSION)
  transport.away.mockResolvedValue(false)
  transport.supports.mockResolvedValue(true)
  transport.dismiss.mockResolvedValue({ dismissed: 0 })
  transport.settle.mockResolvedValue(undefined)
  transport.dispatch.mockResolvedValue({ delivered: true })
  const subscribe = async (
    request: { method: string },
    emit: (response: RuntimeRpcResponse<unknown>) => void
  ) => {
    if (request.method === 'agentSession.subscribeTurnCompletions') {
      fixture.completion = emit
    } else if (request.method === 'agentSession.subscribeStatus') {
      fixture.status = emit
    } else {
      fixture.journal = emit
    }
    return { unsubscribe: () => {} }
  }
  vi.stubGlobal('api', {
    gh: {},
    runtime: { subscribe },
    runtimeEnvironments: {
      subscribe: (
        request: { method: string },
        callbacks: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
      ) => subscribe(request, callbacks.onResponse)
    },
    notifications: {
      dispatch: transport.dispatch,
      dismiss: transport.dismiss,
      settleStructuredPrompts: transport.settle,
      getDesktopAwayState: transport.away
    }
  })
  transport.call.mockImplementation(async (_target, method: string, params: unknown) => {
    if (method === 'agentSession.history') {
      return await new Promise((resolve) => {
        fixture.hydrate = () => resolve({ ok: true, page: history() })
      })
    }
    const reply = await call(method, params, STRUCTURED_CLIENT, {
      retireStructuredAttention: fixture.controller.retireStructuredAttention.bind(
        fixture.controller
      )
    })
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    return reply.result
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({
          id: TAB,
          worktreeId: WORKSPACE,
          groupId: 'group',
          contentType: 'agent-session',
          entityId: SESSION,
          agentSessionAgent: 'claude'
        })
      ]
    },
    groupsByWorktree: {
      [WORKSPACE]: [
        makeTabGroup({ id: 'group', worktreeId: WORKSPACE, activeTabId: TAB, tabOrder: [TAB] })
      ]
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'group' },
    activeWorktreeId: WORKSPACE,
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: [],
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    settings: createGlobalSettingsFixture({ experimentalTerminalAttention: true })
  })
})
afterEach(() => {
  cleanup()
  clearStructuredHostStub()
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionTurnCompletionFeedsForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(fixture.directory, { recursive: true, force: true })
})
