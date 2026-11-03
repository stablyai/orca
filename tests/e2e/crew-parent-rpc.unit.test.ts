import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../src/shared/protocol-version'
import {
  createSessionCallerHarness,
  orchestrationRequest
} from '../../src/main/runtime/rpc/orchestration-session-caller-test-fixture'
import { configureFederationWorkerRuntime } from '../../src/main/runtime/rpc/methods/orchestration/federation/federation-runtime.test-support'
import { buildCrewSnapshot } from '../../src/main/runtime/orchestration/crew/crew-read-model'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('composes actual local and paired RPC claims in either order and preserves detached CLI refusal', async () => {
  for (const order of ['local-first', 'remote-first']) {
    const h = createSessionCallerHarness(hostRef)
    try {
      vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
      vi.stubEnv('ORCA_PANE_KEY', '')
      configureFederationWorkerRuntime(h.runtime)
      vi.spyOn(h.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
      const pane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const handle = 'term_windows_worker'
      const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      vi.mocked(h.runtime.getTerminalPaneKey).mockImplementation((value) =>
        value === 'term_coord' ? coordinatorPane : value === handle ? pane : null
      )
      const run = h.db.createRun({
        objective: 'Local manager',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: coordinatorPane
      })
      const task = h.db.createTask({ runId: run.id, spec: 'Existing terminal' })
      h.db.updateTaskStatus(task.id, 'ready')
      const local = () =>
        h.dispatch(
          orchestrationRequest('orchestration.dispatch', {
            from: 'term_coord',
            run: run.id,
            task: task.id,
            to: handle,
            inject: false
          })
        )
      const remote = () =>
        h.dispatch(
          orchestrationRequest('orchestration.federationAttachStart', {
            dispatchId: 'ctx_remote_parent',
            runId: 'run_remote_home',
            taskId: 'task_remote_parent',
            taskSpec: 'Paired worker',
            protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
            worktree: 'new-top-level',
            repo: 'id:windows-repo',
            name: 'worker',
            agent: 'codex'
          })
        )
      const results =
        order === 'local-first' ? [await local(), await remote()] : [await remote(), await local()]
      for (const result of results) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
      }
      const deps = {
        db: h.db,
        hostKey: 'local',
        retainedDbExists: true,
        records: null,
        statuses: [],
        liveHandle: (value: string) => value === handle || value === 'term_coord',
        handleForPane: (value: string) => (value === pane ? handle : null),
        paneForHandle: (value: string) => (value === handle ? pane : null),
        processForHandle: (value: string) => h.runtime.getTerminalProcessIncarnation(value),
        name: () => 'Manager'
      }
      const parents = buildCrewSnapshot(handle, deps).sections.managedBy
      const attachment = h.db.getRemoteDispatchAttachment('ctx_remote_parent')
      if (!attachment) {
        throw new Error('Expected the actual paired worker attachment')
      }
      const localKey = JSON.stringify(['local', 'term_coord'])
      const homeKey = JSON.stringify([attachment.home_peer_fingerprint, 'run:run_remote_home'])
      expect(parents.map((row) => row.partyKey).sort()).toEqual([localKey, homeKey].sort())
      const localParent = parents.find((row) => row.partyKey === localKey)
      const homeParent = parents.find((row) => row.partyKey === homeKey)
      expect(localParent).toMatchObject({
        role: 'manager',
        openTarget: { kind: 'terminal', handle: 'term_coord' }
      })
      expect(localParent).not.toHaveProperty('sendAddress')
      expect(homeParent).toMatchObject({ role: 'manager', sendAddress: 'run:run_remote_home' })
      expect(homeParent?.openTarget).toBeUndefined()
      if (!homeParent?.sendAddress) {
        throw new Error('Expected the published attached Run-home address')
      }
      const delivery = vi.spyOn(h.runtime, 'deliverPendingMessagesForHandle')
      const notification = vi.spyOn(h.runtime, 'notifyMessageArrived')
      const effects = () => ({
        messages: h.db.getInbox(),
        relays: h.db.listFederationRelay({
          dispatchId: 'ctx_remote_parent',
          direction: 'to_home',
          afterSequence: 0
        }),
        deliveries: delivery.mock.calls.length,
        notifications: notification.mock.calls.length
      })
      const receipts: unknown[] = []
      const client = new RuntimeClient('/tmp/crew-parent-routing', 1000, null, null)
      vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
        const response = await h.dispatch(
          orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params))
        )
        if (!response.ok) {
          throw new RuntimeClientError(response.error.code, response.error.message)
        }
        receipts.push(response.result)
        return {
          ...response,
          result: response.result,
          _meta: { runtimeId: 'crew-parent-test' }
        }
      })
      const beforeWrongLocal = effects()
      await expect(
        dispatch(['orchestration', 'send'], {
          client,
          flags: new Map([
            ['from', handle],
            ['to', 'term_coord'],
            ['subject', 'Attached local parent'],
            ['body', 'Local must refuse']
          ]),
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: 'Federated Dispatch messages route to their Run home; omit --to and --run.'
      })
      expect(effects()).toEqual(beforeWrongLocal)
      const beforeHome = effects()
      await dispatch(['orchestration', 'send'], {
        client,
        flags: new Map([
          ['from', handle],
          ['to', homeParent.sendAddress],
          ['subject', 'Attached home parent'],
          ['body', 'Hello home'],
          ['type', 'status']
        ]),
        cwd: '/tmp',
        json: true
      })
      expect(receipts.at(-1)).toMatchObject({
        relay: { dispatchId: 'ctx_remote_parent', destination: 'run_home', accepted: true }
      })
      const afterHome = effects()
      expect(afterHome.messages).toEqual(beforeHome.messages)
      expect(afterHome.deliveries).toBe(beforeHome.deliveries)
      expect(afterHome.notifications).toBe(beforeHome.notifications)
      expect(afterHome.relays.slice(0, beforeHome.relays.length)).toEqual(beforeHome.relays)
      expect(afterHome.relays).toHaveLength(beforeHome.relays.length + 1)
      const homeRelay = afterHome.relays.at(-1)
      expect(homeRelay).toMatchObject({ dispatch_id: 'ctx_remote_parent', direction: 'to_home' })
      expect(JSON.parse(homeRelay!.payload)).toMatchObject({
        from: handle,
        subject: 'Attached home parent',
        body: 'Hello home',
        type: 'status'
      })
      const beforeDetached = effects()
      await expect(
        dispatch(['orchestration', 'send'], {
          client,
          flags: new Map([
            ['from', 'term_detached'],
            ['to', 'run:run_remote_home'],
            ['subject', 'Detached parent'],
            ['body', 'Hello']
          ]),
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
      expect(
        h.db.db.prepare("SELECT sequence FROM messages WHERE subject = 'Detached parent'").all()
      ).toEqual([])
      expect(effects()).toEqual(beforeDetached)
    } finally {
      h.close()
    }
  }
})
