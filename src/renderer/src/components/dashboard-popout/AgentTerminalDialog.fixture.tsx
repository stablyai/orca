import { defineFixture } from '@/component-fixtures/component-fixture'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session/agent-session-wire'
import { getStructuredAgentSessionReadOwner } from '../native-chat/session/structured/read/structured-agent-session-read-owner'
import { AgentTerminalPanel } from './AgentTerminalDialog'

const session = { sessionId: 'dashboard-demo', target: { kind: 'local' } } as const
const page: AgentSessionHistoryPage = {
  sessionId: session.sessionId,
  epoch: 'demo',
  direction: 'tail',
  removedItemIds: [],
  submissions: [],
  items: [
    {
      itemId: 'user',
      revision: 0,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review the restoration fix and explain the result.' }]
      }
    },
    {
      itemId: 'assistant',
      revision: 0,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: 'The regression checks passed.\n\n- Existing sessions keep their runtime owner.\n- The preview reads the recorded conversation.'
          }
        ]
      }
    }
  ],
  window: {
    oldest: { epoch: 'demo', sequence: 1 },
    newest: { epoch: 'demo', sequence: 2 },
    nextCursor: { epoch: 'demo', sequence: 1 }
  },
  liveCursor: { epoch: 'demo', sequence: 2 },
  hasOlder: false,
  hasNewer: false
}

export const nativeChat = defineFixture({
  width: 760,
  setup: () => {
    const owner = getStructuredAgentSessionReadOwner(session.sessionId, session.target)
    owner.publishCreated(page)
    const snapshot = { ...owner.getSnapshot(), current: true }
    owner.getSnapshot = () => snapshot
    owner.activate = () => () => {}
  },
  interact: (frame) =>
    new Promise<void>((resolve, reject) => {
      const ready = (): boolean =>
        frame.textContent?.includes('The regression checks passed.') === true
      if (ready()) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        observer.disconnect()
        reject(new Error('Chat preview did not finish loading'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (ready()) {
          clearTimeout(timeout)
          observer.disconnect()
          resolve()
        }
      })
      observer.observe(frame, { childList: true, subtree: true })
    }),
  render: () => (
    <div className="flex h-96 flex-col bg-background">
      <AgentTerminalPanel
        card={{
          paneKey: 'chat:demo',
          ptyId: null,
          chatSession: session,
          agentType: 'claude',
          bucket: 'working',
          dotState: 'working',
          task: 'Review the restoration fix',
          repoId: 'demo',
          worktreeId: 'workspace',
          tabId: 'chat',
          leafId: null,
          repoName: 'Example',
          worktreeName: 'Example workspace',
          executionHostId: 'local',
          startedAt: 1,
          finishedAt: null,
          stateChangedAt: 1,
          unseen: true
        }}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    </div>
  )
})
