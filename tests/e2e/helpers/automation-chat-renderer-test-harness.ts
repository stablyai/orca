import type { AutomationRun } from '../../../src/shared/automations-types'
import { createAutomationRunWorkspaceAction } from '../../../src/renderer/src/components/automations/automation-run-workspace-action'
import type { AutomationsPageActionContext } from '../../../src/renderer/src/components/automations/automations-page-action-context'
import { expect, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../src/shared/runtime-client-target'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'
import { RuntimeRpcEnvelopeSchema } from '../../../src/shared/runtime-rpc-envelope'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/electron-remote-runtime-client-capabilities'
import { decodeSessionTabsDeltaEvents } from '../../../src/main/ipc/runtime-environments/runtime-environment-session-tabs-delta-decoding'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../../src/main/runtime/rpc/methods/structured-agent-session'
import { SESSION_TAB_METHODS } from '../../../src/main/runtime/rpc/methods/session-tabs'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { createTestStore } from '../../../src/renderer/src/store/slices/store-test-helpers'
import type { SessionTabsStreamEvent } from '../../../src/renderer/src/runtime/web-session-tabs-sync/state'
import { applyStructuredSessionTabSnapshots } from '../../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { applyWebSessionTabsSnapshot } from '../../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import { decideWebSessionTabsSnapshot } from '../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions'

export class ChatOpenTestRuntime extends OrcaRuntimeService {
  protected override async refreshMobileSessionPtyRecords() {
    return new Set<string>()
  }
}

/** Only transport and PTY census are bridged; record reveal, publication, mirror and selection stay real. */
export async function createChatRendererBridge(
  runtime: OrcaRuntimeService,
  workspace: string,
  target: RuntimeClientTarget,
  store: ReturnType<typeof createTestStore> = createTestStore()
) {
  const paired = target.kind === 'environment'
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      ...STRUCTURED_AGENT_SESSION_METHODS.filter((method) =>
        ['agentSession.close', 'agentSession.history', 'agentSession.reveal'].includes(method.name)
      ),
      ...SESSION_TAB_METHODS.filter((method) =>
        [
          'session.tabs.list',
          'session.tabs.close',
          'session.tabs.activate',
          'session.tabs.subscribe'
        ].includes(method.name)
      )
    ]
  })
  let request = 0
  const options = {
    clientKind: 'runtime' as const,
    clientCapabilities: [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES]
  }
  const calls: { target: RuntimeClientTarget; method: string; params: unknown }[] = []
  const call = async (recipient: RuntimeClientTarget, method: string, params: unknown) => {
    expect(recipient).toEqual(target)
    calls.push({ target: recipient, method, params })
    const reply = await dispatcher.dispatch(
      { id: `reopen-${++request}`, authToken: 'fixture', method, params },
      options
    )
    if (!reply.ok) {
      console.info('D1 transport refusal', method, JSON.stringify(reply.error))
    }
    if (!reply.ok) {
      throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
    }
    return reply.result
  }
  const apply = (snapshot: RuntimeMobileSessionTabsResult) => {
    if (paired) {
      if (
        decideWebSessionTabsSnapshot(
          snapshot,
          target.kind === 'environment' ? target.environmentId : ''
        ).apply
      ) {
        store.setState((state) =>
          applyWebSessionTabsSnapshot(
            state,
            snapshot,
            target.kind === 'environment' ? target.environmentId : ''
          )
        )
      }
    } else {
      applyStructuredSessionTabSnapshots([snapshot])
    }
  }
  const inventory = async () => {
    const snapshot = await runtime.listMobileSessionTabs(`id:${workspace}`)
    apply(snapshot)
    return snapshot
  }
  // Only the transport is bridged: paired mirrors receive the actual production subscription.
  const subscription = new AbortController()
  if (paired) {
    const decode = decodeSessionTabsDeltaEvents('session.tabs.subscribe', (payload) => {
      if (payload.type !== 'response' || !payload.response.ok) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real subscription handler emitted this frame and the production decoder reconstructed its tab deltas.
      const event = payload.response.result as SessionTabsStreamEvent
      if (event.type === 'snapshot' || event.type === 'updated') {
        apply(event)
      }
    })
    await dispatcher.dispatchStreaming(
      {
        id: 'reopen-stream',
        authToken: 'fixture',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${workspace}` }
      },
      (json) => {
        const response = RuntimeRpcEnvelopeSchema.parse(JSON.parse(json))
        if ('ok' in response) {
          decode({ type: 'response', response })
        }
      },
      { ...options, signal: subscription.signal }
    )
  }
  const selected = () => {
    const state = store.getState()
    const group = state.groupsByWorktree[workspace]?.find(
      (candidate) => candidate.id === state.activeGroupIdByWorktree[workspace]
    )
    return state.unifiedTabsByWorktree[workspace]?.find((tab) => tab.id === group?.activeTabId)
  }
  return { store, calls, call, inventory, apply, selected, dispose: () => subscription.abort() }
}

export async function exerciseRecordedChatOpen(
  runtime: OrcaRuntimeService,
  run: AutomationRun,
  bind: (renderer: Awaited<ReturnType<typeof createChatRendererBridge>> | null) => void
) {
  if (!run.workspaceId || !run.chatSessionId) {
    throw new Error('a recorded Chat is required')
  }
  const renderer = await createChatRendererBridge(runtime, run.workspaceId, { kind: 'local' })
  renderer.store.setState({ activeWorktreeId: run.workspaceId })
  const pageContext = {
    store: {
      repoForRow: () => undefined,
      worktreeForRow: () => ({ id: run.workspaceId, hostId: 'local' })
    },
    list: { selectedRow: { key: 'row' } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only row/workspace lookup is scripted; the real Details action, opener, RPC, host, publication and renderer store execute.
  const context = pageContext as unknown as AutomationsPageActionContext
  bind(renderer)
  try {
    createAutomationRunWorkspaceAction(context)(run)
    await vi.waitFor(() =>
      expect(renderer.selected()).toMatchObject({
        entityId: run.chatSessionId,
        executionHostId: 'local'
      })
    )
    await renderer.inventory()
    expect(renderer.selected()?.entityId).toBe(run.chatSessionId)
  } finally {
    renderer.dispose()
    bind(null)
  }
}
