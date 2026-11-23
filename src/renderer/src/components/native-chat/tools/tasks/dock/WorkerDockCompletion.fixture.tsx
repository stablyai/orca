import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { botPanelPage, fixtureCos } from '../../../../../component-fixtures/fixture-bot-panel'
import { stubBots } from '../../../../../component-fixtures/fixture-bots'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { Button } from '@/components/ui/button'
import NativeChatView from '../../../NativeChatView'
import {
  getOrCreateStructuredReadOwner,
  retireStructuredAgentSessionReadOwner,
  structuredReadOwnerKey
} from '../../../session/structured/read/structured-agent-session-read-owner-registry'
import type {
  StructuredAgentSessionReadOwner,
  StructuredAgentSessionReadSnapshot
} from '../../../session/structured/read/structured-agent-session-read-owner-contract'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { folderWorkspaceKey } from '../../../../../../../shared/workspace/identity/workspace-scope'
import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  WorkerDockEntry,
  WorkerDockSnapshot
} from '../../../../../../../shared/orchestration/dock/worker-dock'

const local = { kind: 'local' } as const
const source = 'f34c616a-a277-4d31-9311-a083e140be11'
const botSource = '72ad7475-38a6-4313-a540-21d7a2232490'
const report = 'The worker verified the release notes.'

function completionFixture(isBot: boolean) {
  const sessionId = isBot ? botSource : source
  const tabId = `fixture-chat-${sessionId}`
  const home = folderWorkspaceKey(fixtureCos.folderWorkspaceId)
  let finish: () => void
  return defineFixture({
    width: 720,
    store: {
      ...botPanelPage(false, null),
      unifiedTabsByWorktree: {
        [home]: [
          makeStructuredChatTab({
            id: tabId,
            worktreeId: home,
            entityId: sessionId,
            agentSessionAgent: 'claude'
          })
        ]
      }
    },
    setup: () => {
      stubBots(
        isBot ? [{ ...fixtureCos, name: 'Release assistant', chatSessionId: sessionId }] : []
      )
      const nonce = Date.now()
      const message = (sequence: number, text: string): AgentJournalRenderItem => ({
        itemId: `fixture-message-${sequence}`,
        revision: 1,
        sequence,
        observedAt: nonce + sequence,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
      })
      const presence = { revision: `fixture-worker-${nonce}:1`, open: true }
      let snapshot: StructuredAgentSessionReadSnapshot = {
        state: {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          status: 'ready',
          items: [message(1, 'The release notes are with the worker.')],
          backgroundTasks: { state: 'monitoring', workerDock: presence }
        },
        loadingOlder: false,
        olderHistoryGeneration: 0,
        initialHistoryAutoLoad: false,
        current: true
      }
      const listeners = new Set<() => void>()
      const noSubscription = () => () => {}
      const owner: StructuredAgentSessionReadOwner = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        activate: noSubscription,
        retain: noSubscription,
        retainHistory: noSubscription,
        subscribeCommandsChanged: noSubscription,
        trimHistory: () => {},
        dispose: () => {},
        loadOlder: async () => 'exhausted',
        admit: async () => {},
        trackSend: () => ({ issue: () => {}, settle: () => {} }),
        publishCreated: () => {}
      }
      retireStructuredAgentSessionReadOwner(sessionId, local)
      getOrCreateStructuredReadOwner(structuredReadOwnerKey(sessionId, local), () => owner)

      const worker: WorkerDockEntry = {
        id: 'fixture-worker',
        dispatchId: 'ctx_fixture_completion',
        source: `orca_session_id:${sessionId}`,
        name: 'Release worker',
        title: 'Verify the release notes',
        kind: 'worker',
        model: null,
        state: 'running',
        changedAt: nonce,
        startedAt: nonce,
        reason: null,
        settlement: null,
        resultId: null,
        stoppable: true,
        ownerActionsAvailable: true
      }
      let dock: WorkerDockSnapshot = {
        revision: 1,
        expired: false,
        identities: [{ ...worker, hasModel: false }],
        rows: [worker],
        anchor: worker.id
      }
      const runtime = window.api.runtime
      const events = new Set<(result: WorkerDockSnapshot) => void>()
      window.api.runtime = {
        ...runtime,
        subscribe: async (request, callback) => {
          if (request.method !== 'orchestration.workerDockSubscribe') {
            return runtime.subscribe(request, callback)
          }
          const send = (result: WorkerDockSnapshot) =>
            callback({
              id: `fixture-${result.revision}`,
              ok: true,
              result,
              _meta: { runtimeId: 'fixture' }
            })
          events.add(send)
          send(dock)
          return { unsubscribe: () => void events.delete(send), sendBinary: () => {} }
        }
      }
      finish = () => {
        if (dock.revision !== 1) {
          return
        }
        // Older hosts return Finished references in the snapshot's extra `results` field.
        const completed = {
          revision: 2,
          expired: false,
          identities: [],
          rows: [],
          anchor: null,
          results: [
            {
              id: 'fixture-result',
              dispatchId: worker.dispatchId,
              name: worker.name,
              title: worker.title,
              summary: report,
              at: nonce + 2,
              settlement: 'worker_report:fixture-result',
              outcome: 'succeeded'
            }
          ]
        }
        dock = completed
        snapshot = {
          ...snapshot,
          state: { ...snapshot.state, items: [...snapshot.state.items, message(2, report)] }
        }
        for (const listener of listeners) {
          listener()
        }
        for (const onEvent of events) {
          onEvent(dock)
        }
      }
    },
    render: () => (
      <>
        <Button onClick={() => finish()}>Complete fixture worker</Button>
        <div className="h-[640px]">
          <NativeChatView
            mode="structured"
            agent="claude"
            tabId={tabId}
            sessionId={sessionId}
            target={local}
            isVisible
            isFocusedGroup
          />
        </div>
      </>
    )
  })
}

export const coordinator = completionFixture(false)
export const bot = completionFixture(true)
