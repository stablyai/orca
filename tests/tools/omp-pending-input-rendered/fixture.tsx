import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeChatMessageList } from '../../../src/renderer/src/components/native-chat/NativeChatMessageList'
import { NativeChatQuestionCard } from '../../../src/renderer/src/components/native-chat/NativeChatQuestionCard'
import { NativeChatApprovalCard } from '../../../src/renderer/src/components/native-chat/NativeChatApprovalCard'
import type { NativeChatLiveSession } from '../../../src/renderer/src/components/native-chat/use-native-chat-live-session'
import './fixture.css'

const startedAt = Date.now() - 12000
const session: NativeChatLiveSession = {
  agent: 'omp',
  sessionId: 'omp-pending-proof',
  status: 'working',
  messages: [
    {
      id: 'request',
      role: 'user',
      blocks: [{ type: 'text', text: 'Update the project settings.' }],
      timestamp: startedAt,
      source: 'transcript'
    }
  ],
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: () => {},
  readPhase: 'ready'
}

function Fixture() {
  const [pending, setPending] = useState<'question' | 'approval' | null>(null)
  const [working, setWorking] = useState(true)
  const [answer, setAnswer] = useState('')
  const baseline = new URLSearchParams(location.search).has('baseline')
  Object.assign(window, { pendingInputProof: { setPending, finish: () => setWorking(false) } })
  return (
    <main
      className="flex h-screen flex-col bg-background text-foreground"
      data-working={working}
      data-started-at={startedAt}
    >
      <header className="border-b border-border px-4 py-3 text-sm">OMP · Structured chat</header>
      <div className="flex min-h-0 flex-1 flex-col">
        <NativeChatMessageList
          session={session}
          isWorking={working}
          workingStartedAt={startedAt}
          expandSignal={false}
          fontScale={1}
          showTurnStatus
          isAwaitingInput={!baseline && pending !== null}
        />
      </div>
      {pending === 'question' ? (
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'Which indentation should I use?',
                options: [{ label: 'Tabs' }, { label: 'Spaces' }],
                multiSelect: false
              }
            ]
          }}
          onAnswer={(selections) => {
            setAnswer(JSON.stringify(selections))
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: 'Allow settings update?',
            detail: 'Write project settings',
            options: [
              { label: 'Allow', send: 'allow' },
              { label: 'Deny', send: 'deny' }
            ]
          }}
          onChoose={(choice) => {
            setAnswer(choice)
            setPending(null)
          }}
        />
      ) : null}
      <footer className="px-4 py-3 text-sm text-muted-foreground" data-answer={answer}>
        {pending ? 'Waiting for your response' : working ? 'Turn remains active' : 'Turn finished'}
      </footer>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(<Fixture />)
