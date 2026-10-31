// @vitest-environment happy-dom
import {
  fixture,
  transport,
  WORKSPACE,
  TAB,
  NOTIFICATION_SETTINGS
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { powerMonitor } from 'electron'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../src/main/runtime/runtime-mobile-notification-controller'
import { registerNotificationHandlers } from '../../src/main/ipc/notifications'
import {
  createNotificationStore,
  createNotificationRuntime,
  getAllWindowsMock,
  getDispatchHandler,
  handleMock,
  resetNotificationDispatchMocks
} from '../../src/main/ipc/notifications-test-harness'
import {
  call,
  hostCalls,
  SESSION,
  STRUCTURED_CLIENT
} from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import type { AgentSessionTurnCompletionEvent } from '../../src/shared/agent-session-wire'
import { makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { ForwardedStructuredReadFeeds } from '@/runtime/ForwardedStructuredReadFeeds'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'

vi.mock('electron', async () =>
  (await import('../../src/main/ipc/notifications-test-harness')).createElectronModuleMock()
)
vi.mock('../../src/main/ipc/notification-authorization-status', async () =>
  (
    await import('../../src/main/ipc/notifications-test-harness')
  ).createNotificationAuthorizationModuleMock()
)
vi.mock('../../src/main/ipc/ui', async () =>
  (
    await import('../../src/main/ipc/notifications-test-harness')
  ).createTrustedUIRendererModuleMock()
)
vi.mock('../../src/main/tray/system-tray', async () =>
  (await import('../../src/main/ipc/notifications-test-harness')).createSystemTrayModuleMock()
)

const environment = (id: string) => ({
  id,
  name: id,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'endpoint'
})
function ipc(channel: string, ...args: unknown[]): unknown {
  const registration: unknown[] | undefined = handleMock.mock.calls.find(
    ([name]) => name === channel
  )
  const handler = registration?.[1]
  if (typeof handler !== 'function') {
    throw new Error(`missing handler ${channel}`)
  }
  return handler({}, ...args)
}

function wire(controller: RuntimeMobileNotificationController): void {
  resetNotificationDispatchMocks()
  vi.mocked(powerMonitor.on).mockClear()
  let forwarded: ((ids: string[]) => void) | undefined
  getAllWindowsMock.mockReturnValue([
    {
      isDestroyed: () => false,
      isFocused: () => false,
      isVisible: () => false,
      webContents: { send: (_channel: string, ids: string[]) => forwarded?.(ids) }
    }
  ])
  registerNotificationHandlers(
    createNotificationStore(NOTIFICATION_SETTINGS),
    createNotificationRuntime({
      dispatchMobileNotification: controller.dispatch.bind(controller),
      dismissMobileNotification: controller.dismiss.bind(controller),
      retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
      reconcileStructuredPromptAttention:
        controller.reconcileStructuredPromptAttention.bind(controller),
      getForwardedNotificationEnvironments: controller.getForwardedEnvironments.bind(controller),
      onForwardedNotificationEnvironmentsChanged:
        controller.onForwardedEnvironmentsChanged.bind(controller),
      refreshForwardedNotificationEnvironments: () => controller.refreshForwardedEnvironments()
    })
  )
  Object.assign(window.api.notifications, {
    getForwardedEnvironments: async () => ipc('notifications:getForwardedEnvironments'),
    onForwardedEnvironments: (listener: (ids: string[]) => void) => {
      forwarded = listener
      return () => {
        forwarded = undefined
      }
    },
    applyRemoteStructuredRead: async (read: unknown) => {
      ipc('notifications:applyRemoteStructuredRead', read)
    }
  })
  transport.dispatch.mockImplementation(async (request) => {
    const result = await getDispatchHandler()({}, request)
    if (
      !result ||
      typeof result !== 'object' ||
      !('delivered' in result) ||
      typeof result.delivered !== 'boolean'
    ) {
      throw new Error('invalid production dispatch result')
    }
    return { delivered: result.delivered }
  })
}

it.each(['live', 'file reload'] as const)(
  'keeps the actual shared feed after the last tab closes and retires the saved original sender through %s',
  async (mode) => {
    const directory = join(fixture.directory, 'forwarder')
    let controller = new RuntimeMobileNotificationController()
    fixture.relayControllers.push(controller)
    controller.configureDismissalStore(directory)
    wire(controller)
    const events: MobileNotificationEvent[] = []
    controller.onDispatched((event) => events.push(event))
    const unsubscribe = vi.fn()
    const previousSubscribe = window.api.runtimeEnvironments.subscribe
    Object.assign(window.api.runtimeEnvironments, {
      subscribe: vi.fn(async (request, callbacks) => {
        if (request.method !== 'agentSession.subscribeTurnCompletions') {
          return previousSubscribe(request, callbacks)
        }
        const release = fixture.hostFeed.subscribe({
          id: 'forwarder',
          includePrompts: request.params.includePrompts,
          includeReads: request.params.includeReads,
          emit: (event: AgentSessionTurnCompletionEvent) =>
            callbacks.onResponse(
              { id: 'feed', ok: true, result: event },
              { subscriptionId: 'forwarder-feed', requestId: 'feed' }
            )
        })
        return {
          unsubscribe: () => {
            unsubscribe()
            release()
          }
        }
      })
    })
    hostCalls.publishAttentionRead.mockImplementation((read) => fixture.hostFeed.publishRead(read))
    useAppStore.setState({
      activeWorktreeId: 'elsewhere',
      activeWorkspaceExecutionHostId: 'runtime:relay-host',
      runtimeEnvironments: [environment('relay-host')],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKSPACE,
            repoId: 'repo1',
            hostId: 'runtime:relay-host',
            runtimeOwnerEnvironmentId: 'relay-host'
          })
        ]
      },
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          makeUnifiedTab({
            id: TAB,
            worktreeId: WORKSPACE,
            groupId: 'group',
            contentType: 'agent-session',
            entityId: SESSION,
            agentSessionAgent: 'claude',
            executionHostId: 'runtime:relay-host'
          })
        ]
      }
    })
    let screen = render(
      createElement(
        Fragment,
        null,
        createElement(StructuredAgentSessionAttentionBridge),
        createElement(ForwardedStructuredReadFeeds)
      )
    )
    const completionSubscriptions = () =>
      vi
        .mocked(window.api.runtimeEnvironments.subscribe)
        .mock.calls.filter(
          ([request]) => request.method === 'agentSession.subscribeTurnCompletions'
        ).length
    await waitFor(() => expect(completionSubscriptions()).toBe(1))
    await act(async () => {
      fixture.items = fixture.items.map((item) =>
        item.body.kind === 'turn'
          ? {
              ...item,
              revision: item.revision + 1,
              body: { ...item.body, state: 'completed', outcome: 'success' }
            }
          : item
      )
      fixture.sequence++
      fixture.hostFeed.observe(SESSION)
    })
    await waitFor(() => expect(controller.getForwardedEnvironments()).toEqual(['relay-host']))
    expect(transport.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardingSource: { subscriptionId: 'forwarder-feed', requestId: 'feed' }
      })
    )
    const original = events.find((event) => event.type === 'notification')
    if (!original || original.type !== 'notification') {
      throw new Error('forwarded notification missing')
    }
    expect(original.structuredOrigin?.journalCursor).toEqual({
      epoch: 'journal-a',
      sequence: fixture.sequence
    })
    await act(async () => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(unsubscribe).not.toHaveBeenCalled()
    if (mode === 'file reload') {
      await controller.closeDismissals()
      screen.unmount()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      controller = new RuntimeMobileNotificationController()
      fixture.relayControllers.push(controller)
      controller.configureDismissalStore(directory)
      controller.onDispatched((event) => events.push(event))
      wire(controller)
      screen = render(createElement(ForwardedStructuredReadFeeds))
      await waitFor(() => expect(completionSubscriptions()).toBe(2))
    }
    await act(async () => {
      const response = await call(
        'agentSession.acknowledgeAttention',
        { sessionId: SESSION, observedCursor: original.structuredOrigin?.journalCursor },
        STRUCTURED_CLIENT,
        {
          retireStructuredAttention: fixture.controller.retireStructuredAttention.bind(
            fixture.controller
          )
        }
      )
      expect(response.ok).toBe(true)
    })
    await waitFor(() => expect(controller.getForwardedEnvironments()).toEqual([]))
    const dismissals = events.filter((event) => event.type === 'dismiss')
    expect(dismissals).toHaveLength(1)
    expect(dismissals[0].dismissedDelivery).toEqual({
      notificationId: original.notificationId,
      notificationEpoch: original.notificationEpoch,
      notificationSeq: original.notificationSeq
    })
    expect(hostCalls.publishAttentionRead).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(mode === 'file reload' ? 2 : 1)
    screen.unmount()
  }
)

it.each([10, 100])(
  'indexes %s environments, preserves equal/unrelated ownership and releases removal/cleanup despite a late snapshot',
  async (count) => {
    let idReads = 0
    const known = Array.from({ length: count }, (_, i) => ({
      ...environment(`environment-${i}`),
      get id() {
        idReads++
        return `environment-${i}`
      }
    }))
    useAppStore.setState({ unifiedTabsByWorktree: {}, runtimeEnvironments: known })
    let notify!: (ids: string[]) => void
    let resolve!: (ids: string[]) => void
    Object.assign(window.api.notifications, {
      onForwardedEnvironments: (listener: (ids: string[]) => void) => {
        notify = listener
        return () => {}
      },
      getForwardedEnvironments: () =>
        new Promise<string[]>((done) => {
          resolve = done
        })
    })
    const ids = Array.from({ length: count }, (_, i) => `environment-${i}`)
    const owners = ids.map((environmentId) =>
      getStructuredAgentSessionTurnCompletionFeed({ kind: 'environment', environmentId })
    )
    const releases: ReturnType<typeof vi.fn>[] = []
    const activations = owners.map((owner) => {
      const activate = owner.activate
      return vi.spyOn(owner, 'activate').mockImplementation(() => {
        const release = vi.fn(activate())
        releases.push(release)
        return release
      })
    })
    let renders = 0
    function Holder() {
      renders++
      return createElement(ForwardedStructuredReadFeeds)
    }
    const screen = render(createElement(Holder))
    await act(async () => notify(ids))
    expect(idReads).toBe(count)
    await act(async () => resolve([]))
    idReads = 0
    await act(async () => useAppStore.setState({ activeWorktreeId: 'unrelated' }))
    expect(idReads).toBe(0)
    await act(async () => notify([...ids]))
    expect(idReads).toBe(count)
    expect(activations.every((activate) => activate.mock.calls.length === 1)).toBe(true)
    await act(async () => useAppStore.setState({ runtimeEnvironments: known.slice(1) }))
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases.slice(1).every((release) => release.mock.calls.length === 0)).toBe(true)
    await act(async () => notify([]))
    expect(renders).toBe(1)
    screen.unmount()
    expect(activations.every((activate) => activate.mock.calls.length === 1)).toBe(true)
    expect(releases).toHaveLength(count)
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true)
  }
)

it('leaves old records unheld and invokes the production resume projection for saved interest expiry', async () => {
  const now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const directory = join(fixture.directory, 'old-forwarder')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'mobile-notification-dismissals.json'),
    JSON.stringify([
      {
        notificationId: 'old',
        notificationEpoch: 'old-epoch',
        notificationSeq: 1,
        dismissedThrough: 1,
        expiresAt: now + 60_000
      }
    ])
  )
  const controller = new RuntimeMobileNotificationController()
  fixture.relayControllers.push(controller)
  controller.configureDismissalStore(directory)
  wire(controller)
  expect(controller.getForwardedEnvironments()).toEqual([])
  expect(
    controller.reconcileDismissedPushes([
      { notificationId: 'old', notificationEpoch: 'old-epoch', notificationSeq: 1 }
    ])
  ).toHaveLength(1)
  const refresh = vi.spyOn(controller, 'refreshForwardedEnvironments')
  const powerCalls: readonly (readonly unknown[])[] = vi.mocked(powerMonitor.on).mock.calls
  const resume = powerCalls.find(([name]) => name === 'resume')?.[1]
  if (typeof resume !== 'function') {
    throw new Error('resume handler missing')
  }
  resume()
  expect(refresh).toHaveBeenCalledTimes(1)
})
