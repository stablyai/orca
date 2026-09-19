import React from 'react'
import { createRoot } from 'react-dom/client'
import { NativeChatMessageList } from '../../../src/renderer/src/components/native-chat/NativeChatMessageList'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import './fixture.css'

declare const __TRANSCRIPT_PROOF__: {
  transcripts: { kind: string; phase: string; sessionId: string; messages: NativeChatMessage[] }[]
}
const index = Number(new URLSearchParams(location.search).get('index') ?? '0')
const transcript = __TRANSCRIPT_PROOF__.transcripts[index]
if (!transcript) {
  throw new Error('Missing transcript reader output')
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(
  <main className="flex h-screen flex-col bg-background text-foreground">
    <header className="border-b border-border px-4 py-3 text-sm">OMP · Native chat</header>
    <div className="flex min-h-0 flex-1 flex-col">
      <NativeChatMessageList
        session={{
          agent: 'omp',
          sessionId: transcript.sessionId,
          status: 'ready',
          messages: transcript.messages,
          hasMore: false,
          loadingEarlier: false,
          loadEarlier: () => {},
          readPhase: 'ready'
        }}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    </div>
  </main>
)
