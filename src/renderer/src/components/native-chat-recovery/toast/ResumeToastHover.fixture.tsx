import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeRun } from '../runs/native-chat-resume-run'
import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from '../offers/native-chat-restart-runtime-store'
import type { NativeChatRestartOffer } from '../offers/native-chat-restart-host-offer'
import { NativeChatResumeToastHost } from './NativeChatResumeToastHost'

const NOW = 1_800_000_000_000
const noop = (): void => {}

const chats: ResumeCandidate[] = Array.from({ length: 25 }, (_, index) => ({
  sessionId: `hover-chat-${index}`,
  workspaceId: 'demo-workspace',
  agent: 'claude',
  trigger: 'quit',
  latestPrompt: `Demo task ${index}`,
  recordedAt: NOW - 60_000
}))
const failed: ResumeFailure = {
  ...chats[0]!,
  failedAt: NOW,
  outcome: 'refused',
  reason: 'agent_session_not_attached',
  retryable: false
}
const run: ResumeRun = {
  startedAt: NOW,
  startedBy: 'launch',
  entries: chats.map((candidate) => ({ candidate })),
  inFlight: false,
  continued: chats
    .slice(1)
    .map((candidate) => ({ sessionId: candidate.sessionId, outcome: 'continued' }))
}
const offer: NativeChatRestartOffer = { candidates: [], failed: [failed], listedAt: NOW }

let nextHost = 0
/** "Couldn't resume 1 of 25", over a server store whose reads are pinned and whose actions do nothing. */
function stubStore(): NativeChatRestartStore {
  const store = createNativeChatRestartStore({
    kind: 'environment',
    environmentId: `fixture-hover-${++nextHost}`
  })
  return {
    ...store,
    subscribe: () => noop,
    getNativeChatRestartOffer: () => offer,
    getNativeChatRestartRun: () => run,
    subscribeNativeChatResumeOnRestartDialog: () => noop,
    getNativeChatResumeOnRestartDialogRequest: () => true,
    consumeNativeChatResumeOnRestartDialogRequest: noop,
    releaseFinishedNativeChatRestartRun: noop,
    markFinishedNativeChatRestartRunShown: noop,
    continueNativeChatRestartOffer: async () => {},
    dismissNativeChatRestartOffer: async () => {}
  }
}

function Corner({ stacked = false }: { stacked?: boolean }): React.JSX.Element {
  const [store] = useState(stubStore)
  // Issued before the report's chunk resolves, so the report lands in front of it.
  useEffect(() => {
    if (!stacked) {
      return
    }
    const id = `fixture-hover-other-${++nextHost}`
    toast('Copied demo-branch to the clipboard', { id, duration: Infinity })
    return () => {
      toast.dismiss(id)
    }
  }, [stacked])
  // transform pins the app's fixed-position toaster to this frame instead of the viewport.
  return (
    <div
      className={`relative overflow-hidden bg-background ${stacked ? 'h-56' : 'h-40'}`}
      style={{ transform: 'translateZ(0)' }}
    >
      <div className="absolute inset-x-0 bottom-0 h-10 border-t border-border bg-sidebar" />
      <Toaster />
      <NativeChatResumeToastHost store={store} offerEnabled />
    </div>
  )
}

// Scenes for tests/component-fixtures/resume-toast-hover.spec.ts, which hovers them with a real pointer
// at a 600px viewport (the narrowest main window, where the toaster switches to its narrow layout).
export const corner = defineFixture({ width: 600, render: () => <Corner /> })

/** Another toast was already up when the report arrived, so the report sits in front of it. */
export const stacked = defineFixture({ width: 600, render: () => <Corner stacked /> })
