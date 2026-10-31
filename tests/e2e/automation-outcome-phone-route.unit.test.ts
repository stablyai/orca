import { finishReadExperimentTurn } from '../../src/main/automations/automation-chat-notification-test-fixture'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../src/shared/structured-agent-session-projection'
import { createAutomationRunWriter } from '../../src/main/automations/automation-run-writer'
import { observeAutomationChatRun } from '../../src/main/automations/runtime-chat-run-observer'
import { chatAutomationRunObservation } from '../../src/main/automations/automation-chat-run-observation'
import {
  automationRunOperationId,
  AUTOMATION_AGENT_CALLER
} from '../../src/main/automations/automation-run-operation'
import { rpcCallerOperationKey } from '../../src/main/runtime/rpc/rpc-caller-identity'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS } from '../../src/main/runtime/rpc/methods/structured-agent-session-turn-completion-stream'
import { createStructuredAttentionMobileDelivery } from '../../src/main/runtime/structured-agent-session-mobile-attention'
import {
  createQueuedMessageTestRig,
  eventually
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_LOCATION as LOCATION,
  hostTestMessage
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentSessionTurnCompletionEvent } from '../../src/shared/agent-session-wire'
import type { MobileNotificationEvent } from '../../src/main/runtime/runtime-mobile-notification-controller'
import type { AutomationsChangedPayload } from '../../src/shared/runtime-client-events'
import type { AutomationRun } from '../../src/shared/automations-types'
import {
  deferred,
  fixture
} from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { stubRuntime } from '../../src/main/runtime/rpc/terminal-multiplex-test-harness'
import { RuntimeMobileNotificationController } from '../../src/main/runtime/runtime-mobile-notification-controller'
import { publishAutomationOutcome } from '../../src/main/automations/automation-outcome-notification'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import { subscribeToDesktopNotifications } from '../../mobile/src/notifications/mobile-notifications'
import { pushNotificationRouteData } from '../../mobile/src/notifications/push-receive'
import { getNotificationNavigationTarget } from '../../mobile/src/notifications/notification-routing'

const phone = vi.hoisted(() => ({
  present: vi.fn(),
  dismiss: vi.fn(),
  support: { completed: Promise.resolve(false), signal: new AbortController().signal },
  hosts: [{ id: 'phone-host', publicKeyB64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }]
}))
vi.mock('../../mobile/src/notifications/push-token', () => ({
  getDevicePushToken: async () => null
}))
vi.mock('../../mobile/src/notifications/push-registration', () => ({
  getHostPushSupported: () => false,
  getHostPushSupportCompletion: () => phone.support
}))
vi.mock('../../mobile/src/notifications/notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: async () => ({
    onlyWhenDesktopAway: false,
    sound: false,
    suppressWhileViewing: false
  })
}))
vi.mock('../../mobile/src/transport/host-store', () => ({
  loadHostCatalog: async () => phone.hosts
}))
vi.mock('../../mobile/src/notifications/desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {},
  DESKTOP_NOTIFICATION_CHANNEL_ID: 'fixture'
}))
vi.mock('../../mobile/src/notifications/android-foreground-push', () => ({
  presentForegroundPush: phone.present
}))
vi.mock('../../mobile/src/notifications/push-dismissal-reconciliation', () => ({
  requestNotificationCatchup: async () => {}
}))
vi.mock('../../mobile/src/notifications/notification-permissions', () => ({}))
vi.mock('../../mobile/src/notifications/push-dismissal-watermarks', () => ({
  wasPushDismissed: () => false
}))
vi.mock('../../mobile/src/notifications/push-tray-dismissal', () => ({
  dismissPresentedPushNotification: phone.dismiss
}))
vi.mock('../../mobile/src/notifications/notification-viewing-policy', () => ({
  shouldSuppressNotificationWhileViewing: () => false
}))
vi.mock('../../mobile/src/storage/preferences', () => ({
  loadPushNotificationsEnabled: async () => true
}))
vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../src/main/ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each([true, false])(
  'routes a produced failed outcome through the actual phone receiver to its destination (workspace=%s), without read acknowledgement',
  async (workspace) => {
    phone.present.mockClear()
    const { store } = await fixture()
    const automation = store.listAutomations()[0]
    const run = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed' })
    const seen = vi.spyOn(store, 'markAutomationRunSeen')
    const requests: string[] = []
    let receive: (event: unknown) => void = () => {}
    const client: RpcClient = {
      subscribe: (_method, _params, listener) => {
        receive = listener
        return () => {}
      },
      sendRequest: async (method) => {
        requests.push(method)
        return { id: 'reply', ok: true, result: {}, _meta: { runtimeId: 'host' } }
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const stopPhone = subscribeToDesktopNotifications(client, 'phone-host')
    const controller = new RuntimeMobileNotificationController()
    const stopHost = controller.onDispatched((event) => receive(event))
    const runtime = stubRuntime({
      dispatchMobileNotification: controller.dispatch.bind(controller),
      notifyAutomationsChanged: vi.fn()
    })
    try {
      publishAutomationOutcome(runtime, store, {
        settledRun: {
          name: 'Check',
          agentId: 'codex',
          run: {
            id: run.id,
            automationId: automation.id,
            status: 'dispatch_failed',
            sessionKind: 'chat',
            workspaceId: workspace ? 'workspace' : null,
            chatSessionId: workspace ? 'chat' : null,
            terminalPaneKey: null,
            terminalPtyId: null,
            dispatchedAt: workspace ? 2 : null,
            createdAt: 1
          }
        }
      })
      await vi.waitFor(() => expect(phone.present).toHaveBeenCalledOnce())
      const content: unknown = phone.present.mock.calls[0]?.[1]
      if (!content || typeof content !== 'object' || !('data' in content)) {
        throw new Error('Expected actual receiver route data')
      }
      const data = pushNotificationRouteData(content.data, phone.hosts, true)
      expect(
        getNotificationNavigationTarget(data, { knownHostIds: new Set(['phone-host']) })
      ).toEqual({
        hostId: 'phone-host',
        sessionTarget: workspace
          ? {
              name: '[hostId]/session/[worktreeId]',
              params: {
                hostId: 'phone-host',
                worktreeId: 'workspace',
                paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat'), 'chat')
              }
            }
          : null
      })
      expect(requests).not.toContain('automation.runSeen')
      expect(seen).not.toHaveBeenCalled()
      expect(
        store.listAutomationRuns().find((row) => row.id === run.id)?.failureSeenAt
      ).toBeUndefined()
    } finally {
      stopHost()
      stopPhone()
    }
  }
)

async function readExperimentBounded<T>(work: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('R4 harness boundary did not settle')), 5_000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function exerciseReadExperiment(replacement: boolean, parked: boolean, preCapture = false) {
  const suppressed = replacement && (parked || preCapture)
  phone.present.mockClear()
  phone.dismiss.mockClear()
  const rig = await createQueuedMessageTestRig({ restartable: true })
  const otherEpoch = await createQueuedMessageTestRig({ restartable: true })
  const otherSession = await createQueuedMessageTestRig({
    sessionId: 'other-session',
    restartable: true
  })
  setStructuredAgentSessionHost(rig.host)
  const { store, authority, readState } = await fixture()
  const automation = store.updateAutomation(store.listAutomations()[0].id, {
    name: 'Check',
    agentId: 'codex'
  })
  const runs = [0, 1].map((i) => {
    const run = store.createAutomationRun(automation, 1_800_000_000_000 + i, 'manual')
    return store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      sessionKind: 'chat',
      workspaceId: LOCATION.workspaceId,
      chatSessionId: SESSION
    })
  })
  await store.flushPendingOrThrowAsync()
  const seen = vi.spyOn(store, 'markAutomationRunSeen')
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr36467-read-'))
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  const produced: MobileNotificationEvent[] = []
  const edges: AgentSessionTurnCompletionEvent[] = []
  const payloads: AutomationsChangedPayload[] = []
  let receive: (event: unknown) => void = () => {}
  const requests: string[] = []
  const client: RpcClient = {
    subscribe: (_method, _params, listener) => {
      receive = listener
      return () => {}
    },
    sendRequest: async (method) => {
      requests.push(method)
      return { id: 'reply', ok: true, result: {}, _meta: { runtimeId: 'host' } }
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const stopPhone = subscribeToDesktopNotifications(client, 'phone-host')
  const stopHost = controller.onDispatched((event) => {
    produced.push(event)
    receive(event)
  })
  const runtime = stubRuntime({
    dispatchMobileNotification: controller.dispatch.bind(controller),
    retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
    notifyAutomationsChanged: vi.fn(),
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS
  })
  const attention = controller.createAutomationAttentionOwner()
  rig.host.automationChatInterests.connectAttention(attention.get)
  const writer = createAutomationRunWriter(
    store,
    (payload, delivery) => {
      payloads.push(payload)
      if (replacement) {
        publishAutomationOutcome(runtime, store, payload, delivery)
      }
    },
    attention
  )
  const abort = new AbortController()
  const releases: (() => void)[] = []
  for (const [i, source] of [rig, otherEpoch, otherSession].entries()) {
    const delivery = createStructuredAttentionMobileDelivery({
      readNotificationSettings: () => store.getSettings().notifications,
      readWorkspaceLabels: () => ({ worktreeLabel: 'Check' }),
      isWorkspaceMuted: () => false,
      dispatch: controller.dispatch.bind(controller),
      reconcile: controller.reconcileStructuredPromptAttention.bind(controller),
      now: () => 1_800_000_000_000
    })
    releases.push(
      source.host.subscribeTurnCompletions({
        id: `r4-${i}`,
        includePrompts: true,
        emit: (edge) => {
          if (edge.type !== 'end') {
            edges.push(edge)
            delivery.deliver(
              edge,
              source.host.readStatusSummary(
                edge.type === 'completion' ? edge.completion.sessionId : edge.prompt.sessionId
              )
            )
          }
        }
      })
    )
  }
  const finalWrites: Promise<unknown>[] = []
  let gate: ReturnType<typeof authority.pause> | undefined
  const settleRun = async (run: AutomationRun, name: string) => {
    const message = automationRunOperationId(run, 'reuse-send')
    if (replacement) {
      attention.admit(run.id)
      rig.host.registerAutomationChatRun(run.id, SESSION, message)
    }
    const fields = { body: hostTestMessage('Check seven repositories') }
    expect(
      await rig.host.send(
        { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
        { ...fields, envelope: rig.envelope(fields, 'agentSession.send', message) }
      )
    ).toMatchObject({ ok: true })
    // Main generic control stays unowned until its actual edge is emitted. The changed suppressor
    // therefore takes exactly the same branch and input as pinned main, without editing an edge.
    const heldSnapshot = preCapture && name === 'read-target' ? deferred<void>() : undefined
    const originalSnapshot = rig.host.journalSnapshot.bind(rig.host)
    const snapshotRead = heldSnapshot
      ? vi.spyOn(rig.host, 'journalSnapshot').mockImplementation(async (id) => {
          const snapshot = await originalSnapshot(id)
          if (
            snapshot.items.some((item) => {
              const turn = item.body
              return turn.kind === 'turn' && turn.turnId === name && turn.state !== 'running'
            })
          ) {
            await heldSnapshot.promise
          }
          return snapshot
        })
      : undefined
    const observing = replacement
      ? observeAutomationChatRun(runtime, run, abort.signal, attention.get(run.id))
      : null
    if (observing) {
      await eventually(() =>
        expect(rig.host.automationChatInterests.identity(run.id)).toBeDefined()
      )
    }
    await finishReadExperimentTurn(
      rig,
      SESSION,
      message,
      name,
      name === 'read-target' ? 'success' : 'failure'
    )
    if (heldSnapshot) {
      const snapshot = await originalSnapshot(SESSION)
      expect(store.listAutomationRuns(automation.id).find((row) => row.id === run.id)?.status).toBe(
        'dispatched'
      )
      expect(
        await dispatcher.dispatch({
          id: 'pre-capture-read',
          authToken: 'fixture',
          method: 'agentSession.acknowledgeAttention',
          params: { sessionId: SESSION, observedCursor: snapshot.cursor }
        })
      ).toMatchObject({ ok: true })
      heldSnapshot.resolve()
    }
    const observation = observing
      ? await readExperimentBounded(observing)
      : chatAutomationRunObservation(await rig.host.journalSnapshot(SESSION), message, 'Codex')
    snapshotRead?.mockRestore()
    if (!observation) {
      throw new Error('Actual canonical observer did not resolve finished run')
    }
    finalWrites.push(writer.updateRun({ runId: run.id, ...observation }))
    return observation
  }
  try {
    if (parked) {
      gate = authority.pause()
    }
    const observation = await settleRun(runs[0], 'read-target')
    await (gate ? gate.started.promise : Promise.all(finalWrites))
    const target = edges.find(
      (edge) => edge.type === 'completion' && edge.completion.turnId === 'read-target'
    )
    if (!target || target.type !== 'completion' || !target.completion.journalCursor) {
      throw new Error('Expected canonical completion cursor')
    }
    const read = { sessionId: SESSION, observedCursor: target.completion.journalCursor }
    // A second run on the same session is later than the accepted read boundary.
    await settleRun(runs[1], 'unread-run')
    for (const [source, session, name] of [
      [otherEpoch, SESSION, 'other-epoch'],
      [otherSession, 'other-session', 'other-session']
    ] as const) {
      const sent = source.send(name)
      await sent.result
      await finishReadExperimentTurn(source, session, sent.id, name)
    }
    await vi.waitFor(() =>
      expect(phone.present.mock.calls.length).toBeGreaterThanOrEqual(suppressed ? 2 : 4)
    )
    const ack = await dispatcher.dispatch({
      id: 'read',
      authToken: 'fixture',
      method: 'agentSession.acknowledgeAttention',
      params: read
    })
    expect(ack).toMatchObject({ ok: true, result: { acknowledged: true } })
    const atAcceptedRead = {
      produced: structuredClone(produced),
      durableGeneration: store.automationDurableWriteGeneration(),
      writeGeneration: store.automationWriteGeneration()
    }
    const human = rig.send('A later human turn, keep it independent')
    await human.result
    await finishReadExperimentTurn(rig, SESSION, human.id, 'later-human', 'success', [
      'HUMAN ONLY result.'
    ])
    await vi.waitFor(() =>
      expect(phone.present).toHaveBeenCalledTimes(replacement && parked ? 3 : suppressed ? 4 : 5)
    )
    if (gate) {
      expect(payloads.some((p) => p.settledRun)).toBe(false)
      expect(store.automationDurableWriteGeneration()).toBeLessThan(
        store.automationWriteGeneration()
      )
      gate.finish.resolve()
    }
    await Promise.all(finalWrites)
    await store.flushPendingOrThrowAsync()
    await vi.waitFor(() => expect(phone.present).toHaveBeenCalledTimes(suppressed ? 4 : 5))
    await controller.flushDismissals()
    const dismissed = produced.filter((event) => event.type === 'dismiss')
    if (!replacement) {
      await vi.waitFor(() => expect(phone.dismiss).toHaveBeenCalledOnce())
    }
    const notifications = produced.filter((event) => event.type === 'notification')
    const targetNotification = notifications.find((event) =>
      replacement
        ? event.attentionKey?.includes(runs[0].id)
        : event.structuredOrigin?.cause.kind === 'completion' &&
          event.structuredOrigin.cause.requestId === 'read-target'
    )
    if (!suppressed && (!targetNotification || !targetNotification.notificationId)) {
      throw new Error('Expected actual target delivery')
    }
    const completions = edges.flatMap((event) =>
      event.type === 'completion' ? [event.completion] : []
    )
    const newer = completions.find((edge) => edge.turnId === 'unread-run')
    const epoch = completions.find((edge) => edge.turnId === 'other-epoch')
    const session = completions.find((edge) => edge.turnId === 'other-session')
    const later = completions.find((edge) => edge.turnId === 'later-human')
    if (!newer?.journalCursor || !epoch?.journalCursor || !session || !later) {
      throw new Error('Missing canonical control edges')
    }
    expect(newer.journalCursor.epoch).toBe(read.observedCursor.epoch)
    expect(newer.journalCursor.sequence).toBeGreaterThan(read.observedCursor.sequence)
    expect(epoch.journalCursor.epoch).not.toBe(read.observedCursor.epoch)
    expect(session.sessionId).not.toBe(read.sessionId)
    expect(later.automationOwned).not.toBe(true)
    expect(payloads.filter((p) => p.settledRun)).toHaveLength(suppressed ? 1 : 2)
    expect(payloads.filter((p) => p.reason === 'run').length).toBeGreaterThanOrEqual(2)
    expect(
      store
        .listAutomationRuns(automation.id)
        .filter((row) => runs.some((run) => run.id === row.id))
        .map((row) => row.status)
        .sort()
    ).toEqual(['completed', 'dispatch_failed'])
    expect(rig.host.readStatusSummary(SESSION)?.lastAssistantMessage).toBe('HUMAN ONLY result.')
    expect(seen).not.toHaveBeenCalled()
    expect(requests).not.toContain('automation.runSeen')
    expect(
      store
        .listAutomationRuns(automation.id)
        .filter((run) => runs.some((r) => r.id === run.id))
        .every((run) => run.failureSeenAt === undefined)
    ).toBe(true)
    const state = readState()
    expect(
      state.automationRuns.find((run: { id: string }) => run.id === runs[0].id).outputSnapshot
        .content
    ).toBe('Checking seven repositories.\nChecked seven repositories; all passed.')
    const result = {
      replacement,
      parked,
      read,
      atAcceptedRead,
      ownerIdentity: rig.host.automationChatInterests.identity(runs[0].id),
      edges,
      observation,
      payloads,
      produced,
      presented: phone.present.mock.calls.map((call) => call[1]),
      trayDismissCalls: phone.dismiss.mock.calls,
      durableGeneration: store.automationDurableWriteGeneration(),
      writeGeneration: store.automationWriteGeneration()
    }
    if (process.env.ORCA_AUTOMATION_READ_EVIDENCE_DIR) {
      writeFileSync(
        join(
          process.env.ORCA_AUTOMATION_READ_EVIDENCE_DIR,
          `r5-read-experiment-${replacement ? 'replacement' : 'generic'}-${parked ? 'parked' : 'published'}${preCapture ? '-pre-capture' : ''}.json`
        ),
        JSON.stringify(result, null, 2)
      )
    }
    if (suppressed) {
      expect(targetNotification).toBeUndefined()
      expect(dismissed).toEqual([])
      expect(phone.dismiss).not.toHaveBeenCalled()
      return result
    }
    if (!targetNotification) {
      throw new Error('Expected published target')
    }
    if (replacement) {
      const content: unknown = phone.present.mock.calls.find((call) => {
        const data: unknown = call[1]?.data
        return (
          !!data &&
          typeof data === 'object' &&
          'notificationId' in data &&
          data.notificationId === targetNotification.notificationId
        )
      })?.[1]
      if (!content || typeof content !== 'object' || !('data' in content)) {
        throw new Error('Missing actual produced-success route')
      }
      const authenticated = pushNotificationRouteData(content.data, phone.hosts, true)
      expect(
        getNotificationNavigationTarget(authenticated, { knownHostIds: new Set(['phone-host']) })
      ).toMatchObject({
        hostId: 'phone-host',
        sessionTarget: {
          name: '[hostId]/session/[worktreeId]',
          params: {
            hostId: 'phone-host',
            worktreeId: LOCATION.workspaceId,
            paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(SESSION), SESSION)
          }
        }
      })
    }
    expect
      .soft(
        dismissed.map((event) => event.notificationId),
        'same Chat delivery must retire without touching newer/unrelated deliveries'
      )
      .toEqual([targetNotification.notificationId])
    expect
      .soft(
        phone.dismiss.mock.calls.map((call) => call[0]),
        'actual phone tray dismissal'
      )
      .toEqual([targetNotification.notificationId])
    expect
      .soft(targetNotification.body, 'same-input last assistant preview')
      .toBe('Checked seven repositories; all passed.')
    return result
  } finally {
    gate?.finish.resolve()
    abort.abort()
    await Promise.allSettled(finalWrites)
    writer.dispose()
    releases.forEach((release) => release())
    stopHost()
    stopPhone()
    setStructuredAgentSessionHost(null)
    await controller.closeDismissals()
    rmSync(directory, { recursive: true, force: true })
    await rig.dispose()
    await otherEpoch.dispose()
    await otherSession.dispose()
  }
}

it.each([false, true])('R4 bounded read/context experiment (primary parked=%s)', async (parked) => {
  const generic = await exerciseReadExperiment(false, parked)
  const replacement = await exerciseReadExperiment(true, parked)
  expect(generic.read.observedCursor.epoch).not.toBe('')
  expect(replacement.read.observedCursor.epoch).not.toBe('')
})

it('keeps an accepted read addressable before the actual observer resolves or writer captures', async () => {
  await exerciseReadExperiment(true, false, true)
})
