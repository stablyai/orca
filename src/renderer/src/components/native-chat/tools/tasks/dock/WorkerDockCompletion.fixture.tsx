import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { botPanelPage, fixtureCos } from '../../../../../component-fixtures/fixture-bot-panel'
import { stubBots } from '../../../../../component-fixtures/fixture-bots'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { Button } from '@/components/ui/button'
import { NativeChatStructuredSession } from '../../../NativeChatStructuredSession'
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
    store: isBot
      ? {
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
        }
      : undefined,
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
      const presence = { revision: `fixture-worker:${nonce}`, open: true }
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
        loadOlder: async () => ({ status: 'empty' }),
        admit: async () => {},
        trackSend: () => ({ issue: () => {}, settle: () => {} }),
        publishCreated: () => {}
      }
      retireStructuredAgentSessionReadOwner(sessionId, local)
      getOrCreateStructuredReadOwner(structuredReadOwnerKey(sessionId, local), () => owner)

      const worker = {
        id: 'fixture-worker',
        dispatchId: 'ctx_fixture_completion',
        kind: 'worker',
        state: 'running',
        changedAt: nonce,
        settlement: null,
        ownerActionsAvailable: true
      }
      const { subscribe } = window.api.runtime
      const events = new Set<Parameters<typeof subscribe>[1]>()
      window.api.runtime.subscribe = async (request, callback) => {
        if (request.method !== 'orchestration.workerDockSubscribe') {
          return subscribe(request, callback)
        }
        events.add(callback)
        callback({
          id: 'fixture-1',
          ok: true,
          result: {
            revision: 1,
            expired: false,
            identities: [worker],
            rows: [],
            anchor: worker.id
          },
          _meta: { runtimeId: 'fixture' }
        })
        return { unsubscribe: () => events.delete(callback) }
      }
      finish = () => {
        snapshot = {
          ...snapshot,
          state: { ...snapshot.state, items: [...snapshot.state.items, message(2, report)] }
        }
        for (const listener of listeners) {
          listener()
        }
        for (const onEvent of events) {
          onEvent({
            id: 'fixture-2',
            ok: true,
            result: {
              revision: 2,
              expired: false,
              identities: [],
              rows: [],
              anchor: null,
              results: [
                {
                  id: 'fixture-result',
                  dispatchId: worker.dispatchId,
                  name: 'Release worker',
                  summary: report,
                  at: nonce + 2,
                  settlement: 'worker_report:fixture-result',
                  outcome: 'succeeded'
                }
              ]
            },
            _meta: { runtimeId: 'fixture' }
          })
        }
      }
    },
    render: () => (
      <>
        <Button onClick={() => finish()}>Complete fixture worker</Button>
        <div className="h-[640px]">
          <NativeChatStructuredSession
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
